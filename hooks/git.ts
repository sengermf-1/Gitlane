import type {
  BranchInfo,
  CommitDetail,
  CommitInfo,
  FileChange,
  FileKind,
  GitSnapshot,
  GraphCommit,
  MergeState,
  RepoSnapshot,
} from '../types'
import { GRAPH_FORMAT, parseGraphLog } from './graph'

export type RunInit = {
  cwd?: string
  stdin?: string
  timeoutMs?: number
  env?: Record<string, string>
}

export type RunResult = { exitCode: number; stdout: string; stderr: string }

/** `$.process.run`, passed in so the git logic stays testable. */
export type Run = (argv: readonly string[], init?: RunInit) => Promise<RunResult>

export type Outcome<T> = { isOk: true; value: T } | { isOk: false; error: string }

const SEP = '\x1f'

/**
 * Drops control characters (an escape sequence in a commit message, a
 * colour code in git's output): a surface refuses a tree whose text holds one.
 * Tabs and line breaks stay.
 */
export function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}
const LOG_FORMAT = ['%H', '%h', '%s', '%an', '%ct'].join('%x1f')
// Never wait on a credential prompt nobody can answer.
const NETWORK_ENV = { GIT_TERMINAL_PROMPT: '0' }

export function parseCommit(stdout: string): CommitInfo | null {
  const [hash, short, subject, author, seconds] = stdout.trim().split(SEP)
  if (!hash || !short) {
    return null
  }

  return {
    hash,
    short,
    subject: printable(subject ?? ''),
    author: printable(author ?? ''),
    time: Number(seconds ?? 0) * 1000,
  }
}

export type ParsedStatus = {
  oid: string | null
  branch: string | null
  upstream: string | null
  hasAheadBehind: boolean
  ahead: number
  behind: number
  files: FileChange[]
}

/** Splits `count` space-separated fields; the last one keeps its spaces. */
function fields(line: string, count: number): string[] {
  const out: string[] = []
  let rest = line
  for (let k = 0; k < count - 1; k++) {
    const at = rest.indexOf(' ')
    if (at < 0) {
      break
    }
    out.push(rest.slice(0, at))
    rest = rest.slice(at + 1)
  }
  out.push(rest)

  return out
}

function kindOf(xy: string): FileKind {
  if (xy.includes('A')) {
    return 'added'
  }
  if (xy.includes('D')) {
    return 'deleted'
  }

  return 'modified'
}

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parseStatus(stdout: string): ParsedStatus {
  const parsed: ParsedStatus = {
    oid: null,
    branch: null,
    upstream: null,
    hasAheadBehind: false,
    ahead: 0,
    behind: 0,
    files: [],
  }
  const entries = stdout.split('\0')

  for (let i = 0; i < entries.length; i++) {
    const line = entries[i]
    if (!line) {
      continue
    }

    if (line.startsWith('# ')) {
      const [, key, ...rest] = line.split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') {
        parsed.oid = value === '(initial)' ? null : value
      } else if (key === 'branch.head') {
        parsed.branch = value === '(detached)' ? null : value
      } else if (key === 'branch.upstream') {
        parsed.upstream = value
      } else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value)
        parsed.hasAheadBehind = match !== null
        parsed.ahead = Number(match?.[1] ?? 0)
        parsed.behind = Number(match?.[2] ?? 0)
      }
      continue
    }

    const type = line[0]
    if (type === '1') {
      const f = fields(line, 9)
      const xy = f[1] ?? '..'
      parsed.files.push({ path: f[8] ?? '', kind: kindOf(xy), isStaged: xy[0] !== '.' })
    } else if (type === '2') {
      const f = fields(line, 10)
      const xy = f[1] ?? '..'
      const origPath = entries[++i] ?? ''
      parsed.files.push({ path: f[9] ?? '', origPath, kind: 'renamed', isStaged: xy[0] !== '.' })
    } else if (type === 'u') {
      const f = fields(line, 11)
      parsed.files.push({ path: f[10] ?? '', kind: 'conflict', isStaged: true })
    } else if (type === '?') {
      parsed.files.push({ path: line.slice(2), kind: 'untracked', isStaged: false })
    }
  }

  return parsed
}

async function logOne(run: Run, root: string, rev: string): Promise<CommitInfo | null> {
  const log = await run(['git', 'log', '-1', `--format=${LOG_FORMAT}`, rev, '--'], { cwd: root })

  return log.exitCode === 0 ? parseCommit(log.stdout) : null
}

function failure(result: RunResult): string {
  const text = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/)
  // Hints are noise in a panel; the error is the last real line.
  const lines = text.filter(line => !line.startsWith('hint:'))

  return printable(lines.slice(-3).join(' ')) || `git exited with code ${result.exitCode}`
}

export async function loadSnapshot(run: Run, cwd: string): Promise<GitSnapshot> {
  let top: RunResult
  try {
    top = await run(['git', 'rev-parse', '--show-toplevel'], { cwd })
  } catch {
    return { kind: 'no-binary', cwd }
  }
  if (top.exitCode !== 0) {
    return { kind: 'no-git', cwd }
  }

  const root = top.stdout.trim()
  const [status, remotes] = await Promise.all([
    run(['git', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { cwd: root }),
    run(['git', 'remote'], { cwd: root }),
  ])
  if (status.exitCode !== 0) {
    return { kind: 'error', cwd, message: failure(status) }
  }

  const parsed = parseStatus(status.stdout)
  const merge = await loadMergeState(run, root)
  const isUpstreamGone = parsed.upstream !== null && !parsed.hasAheadBehind
  const [head, lastPushed] = await Promise.all([
    parsed.oid ? logOne(run, root, parsed.oid) : Promise.resolve(null),
    parsed.upstream && !isUpstreamGone ? logOne(run, root, parsed.upstream) : Promise.resolve(null),
  ])

  return {
    kind: 'repo',
    root,
    branch: parsed.branch,
    upstream: parsed.upstream,
    isUpstreamGone,
    ahead: parsed.ahead,
    behind: parsed.behind,
    head,
    lastPushed,
    remotes: remotes.stdout.split(/\r?\n/).filter(Boolean),
    files: parsed.files,
    merge,
  }
}

/** Every path a change touches: a rename's old path too. */
function pathsOf(files: readonly FileChange[]): string[] {
  return files.flatMap(file => (file.origPath ? [file.path, file.origPath] : [file.path]))
}

/** Runs a pathspec command with the paths on stdin, so no list is too long. */
function withPaths(run: Run, root: string, argv: string[], paths: string[]): Promise<RunResult> {
  return run(
    ['git', '--literal-pathspecs', ...argv, '--pathspec-from-file=-', '--pathspec-file-nul'],
    { cwd: root, stdin: paths.join('\0') },
  )
}

/**
 * Commits exactly the selected files: stages them, takes every other staged
 * change back out of the index, and commits the index.
 */
export async function commitSelected(
  run: Run,
  repo: RepoSnapshot,
  selected: readonly FileChange[],
  message: string,
): Promise<Outcome<CommitInfo | null>> {
  const chosen = new Set(selected.map(file => file.path))
  const leftStaged = repo.files.filter(file => !chosen.has(file.path) && file.isStaged)

  if (selected.length > 0) {
    const add = await withPaths(run, repo.root, ['add', '-A'], pathsOf(selected))
    if (add.exitCode !== 0) {
      return { isOk: false, error: failure(add) }
    }
  }

  if (leftStaged.length > 0) {
    const unstage = repo.head
      ? withPaths(run, repo.root, ['restore', '--staged'], pathsOf(leftStaged))
      : withPaths(run, repo.root, ['rm', '--cached', '-r', '-q'], pathsOf(leftStaged))
    const result = await unstage
    if (result.exitCode !== 0) {
      return { isOk: false, error: failure(result) }
    }
  }

  const commit = await run(['git', 'commit', '-q', '-F', '-'], { cwd: repo.root, stdin: message })
  if (commit.exitCode !== 0) {
    return { isOk: false, error: failure(commit) }
  }

  return { isOk: true, value: await logOne(run, repo.root, 'HEAD') }
}

/** The remote a branch with no upstream is published to. */
export function publishRemote(repo: RepoSnapshot): string | null {
  return repo.remotes.includes('origin') ? 'origin' : (repo.remotes[0] ?? null)
}

export async function pushBranch(run: Run, repo: RepoSnapshot): Promise<Outcome<string>> {
  const remote = publishRemote(repo)
  const isPublish = repo.upstream === null || repo.isUpstreamGone
  if (isPublish && remote === null) {
    return { isOk: false, error: 'No remote is configured.' }
  }

  const argv = isPublish ? ['git', 'push', '-u', remote ?? 'origin', 'HEAD'] : ['git', 'push']
  const push = await run(argv, { cwd: repo.root, env: NETWORK_ENV, timeoutMs: 180_000 })
  if (push.exitCode !== 0) {
    return { isOk: false, error: failure(push) }
  }

  return { isOk: true, value: isPublish ? `Branch published to ${remote}.` : 'Pushed.' }
}

export async function fetchRemotes(run: Run, repo: RepoSnapshot): Promise<Outcome<string>> {
  const fetch = await run(['git', 'fetch', '--all', '--prune'], {
    cwd: repo.root,
    env: NETWORK_ENV,
    timeoutMs: 120_000,
  })

  return fetch.exitCode === 0 ? { isOk: true, value: 'Fetched.' } : { isOk: false, error: failure(fetch) }
}

export async function initRepo(run: Run, cwd: string): Promise<Outcome<string>> {
  const init = await run(['git', 'init'], { cwd })

  return init.exitCode === 0 ? { isOk: true, value: 'Repository created.' } : { isOk: false, error: failure(init) }
}

const DIFF_LIMIT = 14_000
const NEW_FILE_LINES = 40

/**
 * What the model reads to suggest a message: recent subjects for style, the
 * diff of the selected tracked files, and the head of each new file.
 */
export async function suggestionContext(
  run: Run,
  repo: RepoSnapshot,
  selected: readonly FileChange[],
  readText: (path: string) => Promise<string | null>,
): Promise<string> {
  const tracked = selected.filter(file => file.kind !== 'untracked')
  const untracked = selected.filter(file => file.kind === 'untracked')
  const parts: string[] = []

  if (repo.head) {
    const log = await run(['git', 'log', '-8', '--format=%s'], { cwd: repo.root })
    if (log.exitCode === 0 && log.stdout.trim()) {
      parts.push(`Recent commit subjects (match their language and style):\n${log.stdout.trim()}`)
    }
  }

  parts.push(
    `Files in this commit:\n${selected.map(file => `${file.kind}: ${file.origPath ? `${file.origPath} -> ` : ''}${file.path}`).join('\n')}`,
  )

  if (tracked.length > 0 && repo.head) {
    const paths = pathsOf(tracked)
    // A command line has a length limit on Windows; past it, diff everything.
    const scope = paths.join('').length < 20_000 ? ['--', ...paths] : []
    const diff = await run(
      ['git', '--literal-pathspecs', 'diff', 'HEAD', '--no-color', '--no-ext-diff', '--stat', '--patch', ...scope],
      { cwd: repo.root },
    )
    if (diff.exitCode === 0 && diff.stdout.trim()) {
      parts.push(`Diff:\n${diff.stdout}`)
    }
  }

  for (const file of untracked.slice(0, 6)) {
    const text = await readText(`${repo.root}/${file.path}`)
    if (text !== null) {
      const head = text.split(/\r?\n/).slice(0, NEW_FILE_LINES).join('\n')
      parts.push(`New file ${file.path} (first lines):\n${head}`)
    }
  }

  const context = parts.join('\n\n')

  return context.length > DIFF_LIMIT ? `${context.slice(0, DIFF_LIMIT)}\n[diff truncated]` : context
}

export const SUGGEST_RULES = [
  'Write a git commit message for the changes below.',
  '- Match the language and style of the recent commit subjects; with none, write in English.',
  '- First line: an imperative summary of at most 72 characters, no trailing period.',
  '- Only when it adds something, a blank line and a short body (at most 4 lines) on why.',
  '- Use what you know from this conversation for the intent, but describe only what the diff holds.',
  '- Reply with the message alone: no code fences, no quotes, no commentary.',
].join('\n')

/** Splits a model reply into a subject line and a body. */
export function parseSuggestion(text: string): { subject: string; body: string } {
  const clean = text
    .replace(/^```[a-z]*\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim()
  const [first = '', ...rest] = clean.split(/\r?\n/)

  return {
    subject: first.replace(/^["'`]|["'`]$/g, '').trim(),
    body: rest.join('\n').trim(),
  }
}

export function commitMessage(subject: string, body: string): string {
  return body.trim() ? `${subject.trim()}\n\n${body.trim()}\n` : `${subject.trim()}\n`
}

export function ago(time: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  if (seconds < 60) {
    return 'now'
  }
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return `${minutes} min ago`
  }
  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    return `${hours} h ago`
  }
  const days = Math.round(hours / 24)
  if (days < 30) {
    return days === 1 ? '1 day ago' : `${days} days ago`
  }
  const months = Math.round(days / 30)
  if (months < 12) {
    return months === 1 ? '1 month ago' : `${months} months ago`
  }
  const years = Math.round(months / 12)

  return years === 1 ? '1 year ago' : `${years} years ago`
}

/** Every branch's history, newest first, for the graph. */
export async function loadGraph(run: Run, root: string, limit: number): Promise<GraphCommit[]> {
  const log = await run(
    ['git', 'log', '--exclude=refs/stash', '--all', '--topo-order', '--decorate=full', `-n${limit}`, `--format=${GRAPH_FORMAT}`],
    { cwd: root },
  )

  return log.exitCode === 0 ? parseGraphLog(log.stdout) : []
}

export type Refs = {
  /** Every ref and the commit it points at: changes whenever the graph would. */
  signature: string
  /** Local branch names. */
  local: string[]
  /** Remote branches with no local branch of the same name, as `origin/name`. */
  remoteOnly: string[]
}

/** Branches and tags in one call, and a signature of them. */
export async function loadRefs(run: Run, root: string): Promise<Refs> {
  const refs = await run(
    ['git', 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'],
    { cwd: root },
  )
  if (refs.exitCode !== 0) {
    return { signature: '', local: [], remoteOnly: [] }
  }

  const names = refs.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => line.slice(line.indexOf(' ') + 1))
  const local = names.filter(ref => ref.startsWith('refs/heads/')).map(ref => ref.slice('refs/heads/'.length))
  const have = new Set(local)
  const remoteOnly = names
    .filter(ref => ref.startsWith('refs/remotes/'))
    .map(ref => ref.slice('refs/remotes/'.length))
    .filter(ref => !ref.endsWith('/HEAD') && ref.includes('/') && !have.has(ref.slice(ref.indexOf('/') + 1)))

  return { signature: refs.stdout, local, remoteOnly }
}

export async function pullBranch(run: Run, repo: RepoSnapshot): Promise<Outcome<string>> {
  if (repo.upstream === null || repo.isUpstreamGone) {
    return { isOk: false, error: 'This branch has no upstream to pull from.' }
  }
  const pull = await run(['git', 'pull', '--ff-only'], { cwd: repo.root, env: NETWORK_ENV, timeoutMs: 180_000 })

  return pull.exitCode === 0 ? { isOk: true, value: 'Pulled.' } : { isOk: false, error: failure(pull) }
}

export async function switchBranch(run: Run, repo: RepoSnapshot, branch: string): Promise<Outcome<string>> {
  const result = await run(['git', 'switch', branch], { cwd: repo.root })

  return result.exitCode === 0 ? { isOk: true, value: `Switched to ${branch}.` } : { isOk: false, error: failure(result) }
}

/** Hashes of commits no remote branch holds yet (so, not on the web). */
export async function loadUnpushed(run: Run, root: string): Promise<string[]> {
  const log = await run(
    ['git', 'rev-list', '--exclude=refs/stash', '--all', '--not', '--remotes', '-n5000'],
    { cwd: root },
  )

  return log.exitCode === 0 ? log.stdout.split(/\r?\n/).filter(Boolean) : []
}

const STAT_LINES = 14

/** One commit as the expanded row shows it: the whole message and the files it touched. */
export async function loadCommitDetail(run: Run, root: string, hash: string): Promise<CommitDetail | null> {
  const [head, stat] = await Promise.all([
    run(['git', 'log', '-1', '--format=%an%x1f%ae%x1f%aI%x1f%B', hash, '--'], { cwd: root }),
    run(['git', 'show', '--stat=70,50', '--format=', '--no-color', hash, '--'], { cwd: root }),
  ])
  if (head.exitCode !== 0) {
    return null
  }
  const [author = '', email = '', date = '', ...message] = head.stdout.split('\x1f')
  const lines = stat.exitCode === 0 ? stat.stdout.split(/\r?\n/).filter(Boolean) : []
  const summary = lines.length > 0 ? (lines[lines.length - 1] ?? '') : ''
  const files = lines.slice(0, -1)

  return {
    hash,
    author: printable(author),
    email: printable(email),
    date,
    message: printable(message.join('\x1f').trim()),
    files: files.slice(0, STAT_LINES).map(printable),
    moreFiles: Math.max(0, files.length - STAT_LINES),
    summary: printable(summary),
  }
}

export async function createBranch(run: Run, repo: RepoSnapshot, name: string): Promise<Outcome<string>> {
  const clean = name.trim()
  if (!clean) {
    return { isOk: false, error: 'Type a branch name.' }
  }
  const check = await run(['git', 'check-ref-format', '--branch', clean], { cwd: repo.root })
  if (check.exitCode !== 0) {
    return { isOk: false, error: `“${clean}” is not a valid branch name.` }
  }
  const made = await run(['git', 'switch', '-c', clean], { cwd: repo.root })

  return made.exitCode === 0 ? { isOk: true, value: `Created ${clean}.` } : { isOk: false, error: failure(made) }
}

/** Creates a local branch that tracks `origin/name` and switches to it. */
export async function trackRemoteBranch(run: Run, repo: RepoSnapshot, remoteRef: string): Promise<Outcome<string>> {
  const result = await run(['git', 'switch', '--track', remoteRef], { cwd: repo.root })

  return result.exitCode === 0
    ? { isOk: true, value: `Switched to ${remoteRef.slice(remoteRef.indexOf('/') + 1)}.` }
    : { isOk: false, error: failure(result) }
}

/** Breaks text into lines of at most `width` characters, keeping blank lines. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    let rest = line
    if (rest === '') {
      out.push('')
    }
    while (rest.length > width) {
      const cut = rest.lastIndexOf(' ', width)
      const at = cut > width * 0.4 ? cut : width
      out.push(rest.slice(0, at).trimEnd())
      rest = rest.slice(at).trimStart()
    }
    if (rest !== '') {
      out.push(rest)
    }
  }

  return out
}

/** A merge under way: the branch being merged (by name when one points at it) and its tip's subject. */
async function loadMergeState(run: Run, root: string): Promise<MergeState | null> {
  const head = await run(['git', 'rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: root })
  if (head.exitCode !== 0) {
    return null
  }
  const [msg, names] = await Promise.all([
    run(['git', 'show', '-s', '--format=%s', 'MERGE_HEAD'], { cwd: root }),
    run(['git', 'name-rev', '--name-only', '--exclude=tags/*', 'MERGE_HEAD'], { cwd: root }),
  ])
  const source = names.exitCode === 0 ? names.stdout.trim().replace(/^remotes\//, '') : ''

  return {
    source: printable(source && source !== 'undefined' ? source : head.stdout.trim().slice(0, 7)),
    subject: msg.exitCode === 0 ? printable(msg.stdout.trim()) : '',
  }
}

/** Every local and remote branch with where it stands, for the Branches tab. */
export async function loadBranchList(run: Run, root: string): Promise<BranchInfo[]> {
  const format = ['%(refname)', '%(objectname:short)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(committerdate:unix)', '%(subject)'].join('%00')
  const [refs, merged, defaultRef] = await Promise.all([
    run(['git', 'for-each-ref', `--format=${format}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes'], { cwd: root }),
    run(['git', 'for-each-ref', '--merged=HEAD', '--format=%(refname)', 'refs/heads', 'refs/remotes'], { cwd: root }),
    run(['git', 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { cwd: root }),
  ])
  if (refs.exitCode !== 0) {
    return []
  }
  const isMerged = new Set(merged.exitCode === 0 ? merged.stdout.split(/\r?\n/).filter(Boolean) : [])
  const remoteDefault = defaultRef.exitCode === 0 ? defaultRef.stdout.trim() : ''
  const defaults = new Set(['main', 'master', remoteDefault, remoteDefault.slice(remoteDefault.indexOf('/') + 1)].filter(Boolean))

  return refs.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => line.split('\0'))
    .filter(([ref = '']) => !ref.endsWith('/HEAD'))
    .map(([ref = '', short = '', upstream = '', track = '', seconds = '0', subject = '']): BranchInfo => {
      const isRemote = ref.startsWith('refs/remotes/')
      const name = ref.slice(isRemote ? 'refs/remotes/'.length : 'refs/heads/'.length)
      const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0)
      const behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0)

      return {
        name,
        kind: isRemote ? 'remote' : 'local',
        short,
        upstream: upstream || null,
        isUpstreamGone: track === 'gone',
        ahead,
        behind,
        time: Number(seconds) * 1000,
        subject: printable(subject),
        isMerged: isMerged.has(ref),
        isDefault: defaults.has(name),
      }
    })
}

/** Deletes a local branch; `force` drops commits no other branch holds. */
export async function deleteLocalBranch(run: Run, root: string, name: string, force: boolean): Promise<Outcome<string>> {
  const result = await run(['git', 'branch', force ? '-D' : '-d', '--', name], { cwd: root })

  return result.exitCode === 0 ? { isOk: true, value: `Deleted ${name}.` } : { isOk: false, error: failure(result) }
}

/** Deletes `origin/name` on the remote itself. */
export async function deleteRemoteBranch(run: Run, root: string, remoteRef: string): Promise<Outcome<string>> {
  const at = remoteRef.indexOf('/')
  const remote = remoteRef.slice(0, at)
  const name = remoteRef.slice(at + 1)
  const result = await run(['git', 'push', remote, '--delete', name], { cwd: root, env: NETWORK_ENV, timeoutMs: 120_000 })

  return result.exitCode === 0 ? { isOk: true, value: `Deleted ${remoteRef}.` } : { isOk: false, error: failure(result) }
}

/** How many commits `branch` would bring into HEAD. */
export async function countIncoming(run: Run, root: string, branch: string): Promise<number> {
  const result = await run(['git', 'rev-list', '--count', `HEAD..${branch}`, '--'], { cwd: root })

  return result.exitCode === 0 ? Number(result.stdout.trim()) || 0 : 0
}

/**
 * Merges `branch` into HEAD with a merge commit. Conflicts are no failure
 * of the call: the merge stays under way for the Changes tab to finish.
 */
export async function mergeBranch(run: Run, root: string, branch: string): Promise<Outcome<string>> {
  const result = await run(['git', 'merge', '--no-ff', '--no-edit', branch], { cwd: root, timeoutMs: 120_000 })
  if (result.exitCode === 0) {
    return { isOk: true, value: `Merged ${branch}.` }
  }
  const pending = await run(['git', 'rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: root })

  return pending.exitCode === 0
    ? { isOk: true, value: `Merging ${branch}: resolve the conflicts to finish.` }
    : { isOk: false, error: failure(result) }
}

export async function abortMerge(run: Run, root: string): Promise<Outcome<string>> {
  const result = await run(['git', 'merge', '--abort'], { cwd: root })

  return result.exitCode === 0 ? { isOk: true, value: 'Merge aborted.' } : { isOk: false, error: failure(result) }
}

const CONFLICT_MARKERS = /^(<{7}|>{7}) /m

/** Stages a conflicted file once its text holds no conflict markers. */
export async function markResolved(
  run: Run,
  root: string,
  path: string,
  readText: (path: string) => Promise<string | null>,
): Promise<Outcome<string>> {
  const text = await readText(`${root}/${path}`)
  if (text !== null && CONFLICT_MARKERS.test(text)) {
    return { isOk: false, error: `${path} still has conflict markers.` }
  }
  const result = await run(['git', '--literal-pathspecs', 'add', '--', path], { cwd: root })

  return result.exitCode === 0 ? { isOk: true, value: '' } : { isOk: false, error: failure(result) }
}

/** Commits the merge with its prepared message, every change included. */
export async function completeMerge(run: Run, repo: RepoSnapshot): Promise<Outcome<string>> {
  if (repo.files.some(file => file.kind === 'conflict')) {
    return { isOk: false, error: 'Resolve every conflict first.' }
  }
  const add = await run(['git', 'add', '-A'], { cwd: repo.root })
  if (add.exitCode !== 0) {
    return { isOk: false, error: failure(add) }
  }
  const result = await run(['git', 'commit', '--no-edit', '-q'], { cwd: repo.root })

  return result.exitCode === 0 ? { isOk: true, value: 'Merge completed.' } : { isOk: false, error: failure(result) }
}

/**
 * Throws away changes: tracked files go back to HEAD in the index and on
 * disk; untracked files are deleted. Cannot be undone.
 */
export async function discardFiles(run: Run, repo: RepoSnapshot, files: readonly FileChange[]): Promise<Outcome<string>> {
  const untracked = files.filter(file => file.kind === 'untracked').map(file => file.path)
  const tracked = pathsOf(files.filter(file => file.kind !== 'untracked' && file.kind !== 'conflict'))

  if (tracked.length > 0) {
    // Without a first commit there is no HEAD to go back to: unstage and delete.
    const result = repo.head
      ? await withPaths(run, repo.root, ['restore', '--staged', '--worktree', '--source=HEAD'], tracked)
      : await withPaths(run, repo.root, ['rm', '-r', '-f', '-q'], tracked)
    if (result.exitCode !== 0) {
      return { isOk: false, error: failure(result) }
    }
  }
  // git clean takes paths on its command line: a few at a time.
  for (let at = 0; at < untracked.length; at += 50) {
    const result = await run(['git', 'clean', '-f', '-q', '--', ...untracked.slice(at, at + 50)], { cwd: repo.root })
    if (result.exitCode !== 0) {
      return { isOk: false, error: failure(result) }
    }
  }

  return { isOk: true, value: files.length === 1 ? `Discarded ${files[0]!.path}.` : `Discarded ${files.length} changes.` }
}
