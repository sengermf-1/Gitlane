import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Busy, FileChange, GitSnapshot, RepoSnapshot } from '../types'
import {
  abortMerge,
  commitMessage,
  completeMerge,
  countIncoming,
  deleteLocalBranch,
  deleteRemoteBranch,
  discardFiles,
  loadBranchList,
  markResolved,
  mergeBranch,
  commitSelected,
  createBranch,
  fetchRemotes,
  initRepo,
  loadCommitDetail,
  loadGraph,
  loadRefs,
  loadSnapshot,
  loadUnpushed,
  parseSuggestion,
  pullBranch,
  pushBranch,
  suggestionContext,
  SUGGEST_RULES,
  switchBranch,
  trackRemoteBranch,
} from './git'
import type { Outcome, Run } from './git'

/** Commits drawn per page of the graph. */
export const GRAPH_PAGE = 80

// The state this file reads and writes; the scan lists atoms per file.
const body = atom({ plugin: 'gitlane', key: 'body' } as const, '')
const branches = atom({ plugin: 'gitlane', key: 'branches' } as const, [])
const busy = atom({ plugin: 'gitlane', key: 'busy' } as const, null)
const commitDetail = atom({ plugin: 'gitlane', key: 'detail' } as const, null)
const excluded = atom({ plugin: 'gitlane', key: 'excluded' } as const, [])
const expanded = atom({ plugin: 'gitlane', key: 'expanded' } as const, null)
const graph = atom({ plugin: 'gitlane', key: 'graph' } as const, [])
const graphLimit = atom({ plugin: 'gitlane', key: 'graphLimit' } as const, GRAPH_PAGE)
const newBranch = atom({ plugin: 'gitlane', key: 'newBranch' } as const, null)
const notice = atom({ plugin: 'gitlane', key: 'notice' } as const, null)
const remoteBranches = atom({ plugin: 'gitlane', key: 'remoteBranches' } as const, [])
const snapshot = atom({ plugin: 'gitlane', key: 'snapshot' } as const, null)
const subject = atom({ plugin: 'gitlane', key: 'subject' } as const, '')
const unpushed = atom({ plugin: 'gitlane', key: 'unpushed' } as const, [])
const branchList = atom({ plugin: 'gitlane', key: 'branchList' } as const, [])
const openBranch = atom({ plugin: 'gitlane', key: 'openBranch' } as const, null)
const confirm = atom({ plugin: 'gitlane', key: 'confirm' } as const, null)
const view = atom({ plugin: 'gitlane', key: 'view' } as const, 'graph')
const discardAsk = atom({ plugin: 'gitlane', key: 'discardAsk' } as const, null)

export function runner($: EngineInterface): Run {
  return (argv, init) => $.process.run(argv, init)
}

/** The status line: branch, sync, changes. Nothing outside a repository. */
function statusLine(snap: GitSnapshot): string | undefined {
  if (snap.kind !== 'repo') {
    return undefined
  }

  const parts = [snap.branch ?? 'detached HEAD']
  if (snap.ahead > 0 || snap.behind > 0) {
    parts.push(`↑${snap.ahead} ↓${snap.behind}`)
  }
  if (snap.files.length > 0) {
    parts.push(snap.files.length === 1 ? '1 change' : `${snap.files.length} changes`)
  }

  return parts.join(' · ')
}

export function selectedFiles(repo: RepoSnapshot, skip: readonly string[]): FileChange[] {
  const left = new Set(skip)

  return repo.files.filter(file => !left.has(file.path))
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i])
}

// Module state: a reload starts it over.
let refreshing: Promise<void> | null = null
let isAgain = false
let isScheduled = false
// What the drawn graph was read from; the graph is read again only when it changes.
let graphKey = ''

async function refreshOnce($: EngineInterface): Promise<void> {
  const snap = await loadSnapshot(runner($), await $.session.cwd())
  await update($, snapshot, () => snap)
  $.ui.status(statusLine(snap))

  if (snap.kind !== 'repo') {
    graphKey = ''
    await update($, graph, () => [])

    return
  }

  const present = new Set(snap.files.map(file => file.path))
  await update($, excluded, list => (list.every(path => present.has(path)) ? list : list.filter(path => present.has(path))))

  const refs = await loadRefs(runner($), snap.root)
  if (!sameList(refs.local, await read($, branches))) {
    await update($, branches, () => refs.local)
  }
  if (!sameList(refs.remoteOnly, await read($, remoteBranches))) {
    await update($, remoteBranches, () => refs.remoteOnly)
  }

  const limit = await read($, graphLimit)
  const key = `${snap.root}\n${snap.head?.hash ?? ''}\n${limit}\n${refs.signature}`
  if (key === graphKey) {
    return
  }
  const [log, local, list] = await Promise.all([
    loadGraph(runner($), snap.root, limit),
    loadUnpushed(runner($), snap.root),
    loadBranchList(runner($), snap.root),
  ])
  await update($, graph, () => log)
  await update($, unpushed, () => local)
  await update($, branchList, () => list)
  graphKey = key
}

/** One refresh at a time; a call during one runs one more after it. */
export function refresh($: EngineInterface): Promise<void> {
  if (refreshing) {
    isAgain = true

    return refreshing
  }
  refreshing = (async () => {
    do {
      isAgain = false
      await refreshOnce($)
    } while (isAgain)
  })().finally(() => {
    refreshing = null
  })

  return refreshing
}

/** A refresh shortly after a burst of tool calls, once for the burst. */
export function refreshSoon($: EngineInterface): void {
  if (isScheduled) {
    return
  }
  isScheduled = true
  $.clock.after(1200, () => {
    isScheduled = false
    void refresh($).catch(() => undefined)
  })
}

/**
 * Runs one action from the pane: marks it busy, then reports. Success is a
 * toast that goes by itself; a failure stays in the pane until dismissed.
 */
async function act(
  $: EngineInterface,
  kind: Exclude<Busy, null>,
  work: () => Promise<Outcome<string>>,
): Promise<Outcome<string> | null> {
  if ((await read($, busy)) !== null) {
    return null
  }
  await update($, busy, () => kind)
  await update($, notice, () => null)
  let result: Outcome<string>
  try {
    result = await work()
    if (result.isOk) {
      if (result.value) {
        $.ui.toast(result.value)
      }
    } else {
      const { error } = result
      await update($, notice, () => ({ kind: 'error', text: error }))
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    result = { isOk: false, error: text }
    await update($, notice, () => ({ kind: 'error', text }))
  }
  await update($, busy, () => null)
  await refresh($)

  return result
}

async function currentRepo($: EngineInterface): Promise<RepoSnapshot | null> {
  const snap = await read($, snapshot)

  return snap?.kind === 'repo' ? snap : null
}

const NO_REPO: Outcome<string> = { isOk: false, error: 'No repository.' }

export function dismissNotice($: EngineInterface) {
  return update($, notice, () => null)
}

/** The repository and its selected files, or why there is nothing to act on. */
async function selection($: EngineInterface): Promise<Outcome<{ repo: RepoSnapshot; files: FileChange[] }>> {
  const repo = await currentRepo($)
  if (!repo) {
    return { isOk: false, error: 'No repository.' }
  }
  const files = selectedFiles(repo, await read($, excluded))
  if (files.length === 0) {
    return { isOk: false, error: 'Select at least one file.' }
  }

  return { isOk: true, value: { repo, files } }
}

/** Asks Claude for a message for `files` and puts it in the form. */
async function writeSuggestion($: EngineInterface, repo: RepoSnapshot, files: FileChange[]): Promise<Outcome<string>> {
  const context = await suggestionContext(runner($), repo, files, async path => {
    try {
      return await $.fs.read(path)
    } catch {
      return null
    }
  })
  const prompt = `${SUGGEST_RULES}\n\n${context}`
  // The fork reads this conversation, so the message can say why; a
  // session with nothing to fork yet falls back to the diff alone.
  let reply = await $.model.fork({ prompt })
  if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
    reply = await $.model.complete({ model: 'haiku', prompt, maxTokens: 400, timeoutMs: 60_000 })
  }
  if (!reply.isAnswered) {
    return { isOk: false, error: `No suggestion (${reply.reason}).` }
  }

  const suggestion = parseSuggestion(reply.text)
  await update($, subject, () => suggestion.subject)
  await update($, body, () => suggestion.body)

  return { isOk: true, value: '' }
}

/** Commits `files` with the form's message, then clears the form. */
async function commitWritten($: EngineInterface, repo: RepoSnapshot, files: FileChange[]): Promise<Outcome<string>> {
  const title = (await read($, subject)).trim()
  if (!title) {
    return { isOk: false, error: 'Write a commit message.' }
  }

  const outcome = await commitSelected(runner($), repo, files, commitMessage(title, await read($, body)))
  if (!outcome.isOk) {
    return outcome
  }
  await update($, subject, () => '')
  await update($, body, () => '')
  const made = outcome.value

  return { isOk: true, value: made ? `Committed ${made.short}.` : 'Committed.' }
}

export function commit($: EngineInterface) {
  return act($, 'commit', async () => {
    const picked = await selection($)

    return picked.isOk ? commitWritten($, picked.value.repo, picked.value.files) : picked
  })
}

/** Claude writes the message and the commit follows at once: one press. */
export function suggestAndCommit($: EngineInterface) {
  return act($, 'suggest', async () => {
    const picked = await selection($)
    if (!picked.isOk) {
      return picked
    }
    const { repo, files } = picked.value

    const written = await writeSuggestion($, repo, files)
    if (!written.isOk) {
      return written
    }
    await update($, busy, () => 'commit')

    return commitWritten($, repo, files)
  })
}

export function push($: EngineInterface) {
  return act($, 'push', async () => {
    const repo = await currentRepo($)

    return repo ? pushBranch(runner($), repo) : NO_REPO
  })
}

export function pull($: EngineInterface) {
  return act($, 'pull', async () => {
    const repo = await currentRepo($)

    return repo ? pullBranch(runner($), repo) : NO_REPO
  })
}

export function fetchAll($: EngineInterface) {
  return act($, 'fetch', async () => {
    const repo = await currentRepo($)

    return repo ? fetchRemotes(runner($), repo) : NO_REPO
  })
}

export function switchTo($: EngineInterface, branch: string) {
  return act($, 'switch', async () => {
    const repo = await currentRepo($)
    if (!repo) {
      return NO_REPO
    }

    return repo.branch === branch ? { isOk: true, value: '' } : switchBranch(runner($), repo, branch)
  })
}

export function trackRemote($: EngineInterface, remoteRef: string) {
  return act($, 'switch', async () => {
    const repo = await currentRepo($)

    return repo ? trackRemoteBranch(runner($), repo, remoteRef) : NO_REPO
  })
}

export function makeBranch($: EngineInterface, name: string) {
  return act($, 'create', async () => {
    const repo = await currentRepo($)
    if (!repo) {
      return NO_REPO
    }
    const made = await createBranch(runner($), repo, name)
    if (made.isOk) {
      await update($, newBranch, () => null)
    }

    return made
  })
}

export function init($: EngineInterface) {
  return act($, 'init', async () => initRepo(runner($), await $.session.cwd()))
}

/** Opens a commit row and loads its message; pressing it again closes it. */
export async function toggleCommit($: EngineInterface, hash: string) {
  if ((await read($, expanded)) === hash) {
    await update($, expanded, () => null)
    await update($, commitDetail, () => null)

    return
  }
  await update($, expanded, () => hash)
  await update($, commitDetail, () => null)
  const repo = await currentRepo($)
  const loaded = repo ? await loadCommitDetail(runner($), repo.root, hash) : null
  // Only if the row is still the one open.
  if ((await read($, expanded)) === hash) {
    await update($, commitDetail, () => loaded)
  }
}

export async function showMore($: EngineInterface) {
  await update($, graphLimit, limit => limit + GRAPH_PAGE)
  await refresh($)
}

function readText($: EngineInterface) {
  return async (path: string) => {
    try {
      return await $.fs.read(path)
    } catch {
      return null
    }
  }
}

/** Opens a branch's actions in the Branches tab; pressing it again closes them. */
export async function toggleBranch($: EngineInterface, name: string) {
  await update($, confirm, () => null)
  await update($, openBranch, open => (open === name ? null : name))
}

export function cancelConfirm($: EngineInterface) {
  return update($, confirm, () => null)
}

/** Deleting asks first; the question says what would be lost. */
export async function askDelete($: EngineInterface, name: string, kind: 'local' | 'remote') {
  const action = kind === 'remote' ? ('delete-remote' as const) : ('delete' as const)
  await update($, confirm, () => ({ action, branch: name }))
}

/** Merging asks first, with the number of commits it brings in. */
export async function askMerge($: EngineInterface, name: string) {
  const repo = await currentRepo($)
  const incoming = repo ? await countIncoming(runner($), repo.root, name) : 0
  await update($, confirm, () => ({ action: 'merge' as const, branch: name, incoming }))
}

/** Runs the action the open question was about. */
export async function confirmAction($: EngineInterface) {
  const asked = await read($, confirm)
  if (!asked) {
    return
  }
  const list = await read($, branchList)
  const branch = list.find(item => item.name === asked.branch)
  const kind = asked.action === 'merge' ? 'merge' : 'delete'

  await act($, kind, async () => {
    const repo = await currentRepo($)
    if (!repo) {
      return NO_REPO
    }
    if (asked.action === 'merge') {
      if (repo.files.some(file => file.kind !== 'untracked')) {
        return { isOk: false, error: 'Commit or stash your changes before merging.' }
      }
      const merged = await mergeBranch(runner($), repo.root, asked.branch)
      if (merged.isOk) {
        await update($, confirm, () => null)
        await update($, openBranch, () => null)
      }

      return merged
    }
    // An unmerged branch was shown as such in the question: delete it anyway.
    const outcome =
      asked.action === 'delete-remote'
        ? await deleteRemoteBranch(runner($), repo.root, asked.branch)
        : await deleteLocalBranch(runner($), repo.root, asked.branch, !(branch?.isMerged ?? false))
    if (outcome.isOk) {
      await update($, confirm, () => null)
      await update($, openBranch, () => null)
    }

    return outcome
  })

  // Conflicts leave the merge under way: finish it in Changes.
  const snap = await read($, snapshot)
  if (snap?.kind === 'repo' && snap.merge) {
    await update($, view, () => 'changes')
  }
}

export function abort($: EngineInterface) {
  return act($, 'abort', async () => {
    const repo = await currentRepo($)

    return repo ? abortMerge(runner($), repo.root) : NO_REPO
  })
}

export function resolve($: EngineInterface, path: string) {
  return act($, 'resolve', async () => {
    const repo = await currentRepo($)

    return repo ? markResolved(runner($), repo.root, path, readText($)) : NO_REPO
  })
}

export function finishMerge($: EngineInterface) {
  return act($, 'commit', async () => {
    const repo = await currentRepo($)

    return repo ? completeMerge(runner($), repo) : NO_REPO
  })
}

/** Hands the conflicts to Claude in this session, as a prompt of its own. */
export async function resolveWithClaude($: EngineInterface) {
  const repo = await currentRepo($)
  if (!repo?.merge) {
    return
  }
  const files = repo.files.filter(file => file.kind === 'conflict').map(file => file.path)
  await $.prompt.submit({
    text:
      `Resolve the merge conflicts from merging ${repo.merge.source} in these files: ${files.join(', ')}. ` +
      'Keep the intent of both sides, remove every conflict marker, and run the checks you would run after a change. ' +
      'Do not stage or commit: I will review and complete the merge from the git panel.',
  })
}

/** Asks before discarding one file's changes, or every change with '*'; asking again closes it. */
export async function askDiscard($: EngineInterface, target: string) {
  await update($, discardAsk, asked => (asked === target ? null : target))
}

export function cancelDiscard($: EngineInterface) {
  return update($, discardAsk, () => null)
}

// When /git-discardall last asked; a second run within the window does the discard.
let discardAskedAt = 0
const DISCARD_WINDOW_MS = 60_000

/**
 * Every uncommitted change, gone for good (untracked files are deleted). It is
 * undoable by nothing, so the first run only says what would go and the same
 * command run again within a minute does it.
 */
export async function discardAll($: EngineInterface): Promise<Outcome<string> | null> {
  await refresh($)
  const repo = await currentRepo($)
  if (!repo) {
    return NO_REPO
  }
  if (repo.files.length === 0) {
    return { isOk: true, value: 'Nothing to discard.' }
  }

  const now = await $.clock.now()
  if (discardAskedAt === 0 || now - discardAskedAt > DISCARD_WINDOW_MS) {
    discardAskedAt = now
    const count = repo.files.length
    const untracked = repo.files.filter(file => file.kind === 'untracked').length
    const extra = untracked > 0 ? ` (${untracked} untracked will be deleted)` : ''

    return {
      isOk: true,
      value: `This throws away ${count === 1 ? '1 change' : `${count} changes`}${extra} and cannot be undone. Run /git-discardall again within a minute to confirm.`,
    }
  }

  discardAskedAt = 0

  return act($, 'discard', () => discardFiles(runner($), repo, repo.files))
}

/** Runs the discard the open question was about. */
export async function confirmDiscard($: EngineInterface) {
  const asked = await read($, discardAsk)
  if (asked === null) {
    return
  }
  await act($, 'discard', async () => {
    const repo = await currentRepo($)
    if (!repo) {
      return NO_REPO
    }
    const files = asked === '*' ? repo.files : repo.files.filter(file => file.path === asked)
    if (files.length === 0) {
      return { isOk: true, value: '' }
    }
    const outcome = await discardFiles(runner($), repo, files)
    if (outcome.isOk) {
      await update($, discardAsk, () => null)
    }

    return outcome
  })
}
