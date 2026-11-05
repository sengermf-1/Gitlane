import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import {
  ago,
  commitSelected,
  completeMerge,
  createBranch,
  deleteLocalBranch,
  deleteRemoteBranch,
  loadBranchList,
  markResolved,
  mergeBranch,
  printable,
  loadRefs,
  loadUnpushed,
  parseStatus,
  parseSuggestion,
  wrapText,
} from '../hooks/git'
import { highlight, matchesBranch, matchesCommit, termsOf } from '../hooks/filter'
import { branchNameProblem } from '../hooks/views/header'
import { layoutGraph, parseGraphLog, renderBadge, renderLaneStrip, trunkTipOf } from '../hooks/graph'
import type { RunInit, RunResult } from '../hooks/git'
import type { RepoSnapshot } from '../types'

const STATUS = [
  '# branch.oid 9903dc5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -1',
  '1 .M N... 100644 100644 100644 abc abc src/components/index.ts',
  '1 D. N... 100644 000000 000000 abc 000 src/old file.css',
  '2 R. N... 100644 100644 100644 abc abc R100 src/new name.ts',
  'src/old name.ts',
  '? notes/todo.md',
  '',
].join('\0')

const LOG = (short: string, subject: string) =>
  [`${short}0000000000000000000000000000000000000`, short, subject, 'Marcos', '1760000000'].join('\x1f')

/** A fake git: records each call and answers from a table by subcommand. */
function fakeGit(answers: Record<string, Partial<RunResult>>) {
  const calls: { argv: readonly string[]; init?: RunInit }[] = []
  const run = async (argv: readonly string[], init?: RunInit): Promise<RunResult> => {
    calls.push({ argv, init })
    const sub = argv.find((arg, i) => i > 0 && !arg.startsWith('-')) ?? ''
    const answer = answers[sub] ?? {}

    return { exitCode: 0, stdout: '', stderr: '', ...answer }
  }

  return { run, calls }
}

describe('parseStatus', () => {
  test('reads branch, tracking and every kind of change', () => {
    const parsed = parseStatus(STATUS)
    expect(parsed.branch).toBe('main')
    expect(parsed.upstream).toBe('origin/main')
    expect(parsed.ahead).toBe(2)
    expect(parsed.behind).toBe(1)
    expect(parsed.files).toEqual([
      { path: 'src/components/index.ts', kind: 'modified', isStaged: false },
      { path: 'src/old file.css', kind: 'deleted', isStaged: true },
      { path: 'src/new name.ts', origPath: 'src/old name.ts', kind: 'renamed', isStaged: true },
      { path: 'notes/todo.md', kind: 'untracked', isStaged: false },
    ])
  })

  test('a repository before its first commit has no oid', () => {
    const parsed = parseStatus('# branch.oid (initial)\0# branch.head main\0')
    expect(parsed.oid).toBe(null)
    expect(parsed.upstream).toBe(null)
  })
})

describe('commitSelected', () => {
  const repo: RepoSnapshot = {
    kind: 'repo',
    root: 'C:/repo',
    branch: 'main',
    upstream: 'origin/main',
    isUpstreamGone: false,
    ahead: 0,
    behind: 0,
    head: null,
    lastPushed: null,
    remotes: ['origin'],
    files: parseStatus(STATUS).files,
    merge: null,
  }

  test('stages the chosen files, unstages the rest, commits the message', async () => {
    const git = fakeGit({ log: { stdout: LOG('abc1234', 'Add panel') } })
    const withHead = { ...repo, head: { hash: 'h', short: 'h', subject: '', author: '', time: 0 } }
    const chosen = withHead.files.filter(file => file.kind !== 'deleted')
    const outcome = await commitSelected(git.run, withHead, chosen, 'Add panel\n')

    expect(outcome).toEqual({ isOk: true, value: expect.objectContaining({ short: 'abc1234' }) })
    const [add, restore, commit] = git.calls
    expect(add?.argv).toContain('add')
    expect(add?.init?.stdin).toBe(
      ['src/components/index.ts', 'src/new name.ts', 'src/old name.ts', 'notes/todo.md'].join('\0'),
    )
    expect(restore?.argv).toContain('restore')
    expect(restore?.init?.stdin).toBe('src/old file.css')
    expect(commit?.argv).toEqual(['git', 'commit', '-q', '-F', '-'])
    expect(commit?.init?.stdin).toBe('Add panel\n')
  })

  test('a failing commit reports git’s own words', async () => {
    const git = fakeGit({ commit: { exitCode: 1, stderr: 'hint: x\nfatal: nothing to commit' } })
    const outcome = await commitSelected(git.run, repo, repo.files.slice(0, 1), 'x\n')

    expect(outcome).toEqual({ isOk: false, error: 'fatal: nothing to commit' })
  })
})

describe('helpers', () => {
  test('a suggestion splits into subject and body, fences dropped', () => {
    expect(parseSuggestion('```\nAdd git panel\n\n- Shows status\n```')).toEqual({
      subject: 'Add git panel',
      body: '- Shows status',
    })
  })

  test('relative time reads in English', () => {
    expect(ago(0, 30_000)).toBe('now')
    expect(ago(0, 5 * 60_000)).toBe('5 min ago')
    expect(ago(0, 3 * 3_600_000)).toBe('3 h ago')
    expect(ago(0, 86_400_000)).toBe('1 day ago')
  })
})

describe('pane', () => {
  const PANE = {
    component: 'Pane',
    requestId: 'git',
    props: {
      title: 'Git',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  } as const
  const OPEN = {
    command: 'git',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  } as const

  test('shows the last push and toggles a file out of the commit', async ($, on) => {
    on('session.cwd', () => ({ value: 'C:/repo' }))
    mock.store(on)
    on('clock.now', () => ({ value: 1_760_003_600_000 }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('process.run', (_$, e) => {
      const sub = e.argv.find((arg, i) => i > 0 && !arg.startsWith('-'))
      const stdout =
        sub === 'rev-parse'
          ? e.argv.includes('MERGE_HEAD')
            ? ''
            : 'C:/repo\n'
          : sub === 'status'
            ? STATUS
            : sub === 'remote'
              ? 'origin\n'
              : sub === 'log'
                ? LOG(e.argv.includes('origin/main') ? 'e2e322b' : '9903dc5', 'Focus review result')
                : ''

      // No merge under way: git's check of MERGE_HEAD fails.
      const exitCode = sub === 'rev-parse' && e.argv.includes('MERGE_HEAD') ? 1 : 0

      return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })

    await $.command.run(OPEN)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'git-panel', surface, ...PANE })
      expect(await ui.find({ text: 'origin/main · 2 commits to push · 1 to pull' })).toBeDefined()
      expect(await ui.find({ text: /last push e2e322b/ })).toBeDefined()
      expect(await ui.find({ key: 'pull' })).toBeDefined()

      await ui.press({ key: 'tab-changes' })
      expect(await ui.find({ text: /^All selected$/ })).toBeDefined()

      await ui.press({ key: 'file:notes/todo.md' })
      expect(await ui.find({ text: /^3 of 4 selected$/ })).toBeDefined()
      expect((await ui.find({ key: 'file:notes/todo.md' }))?.props.dimColor).toBe(true)

      await ui.press({ key: 'all' })
      await ui.press({ key: 'tab-graph' })
      await ui.unmount()
    }
  })

  test('a folder without git offers to create one', async ($, on) => {
    on('session.cwd', () => ({ value: 'C:/empty' }))
    mock.store(on)
    on('ui.status', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('process.run', () => ({
      value: {
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: not a git repository',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }))

    await $.command.run(OPEN)
    const ui = await $.ui.mount({ plugin: 'git-panel', surface: 'desktop', ...PANE })
    expect(await ui.find({ text: /not a git repository/ })).toBeDefined()
    expect(await ui.find({ key: 'init' })).toBeDefined()
  })
})

describe('graph', () => {
  const record = (hash: string, parents: string, refs: string, subject: string) =>
    [hash, parents, refs, subject, 'Demo', '1760000000'].join('\x1f') + '\x1e'
  // main: M merges F; F branched from B; A is the root.
  const LOG = [
    record('m', 'b f', 'HEAD -> refs/heads/main, refs/remotes/origin/main', 'Merge feature'),
    record('f', 'b', 'refs/heads/feature, tag: refs/tags/v1', 'Feature work'),
    record('b', 'a', '', 'Base'),
    record('a', '', '', 'Root'),
  ].join('\n')

  test('reads refs: the checked-out branch first, origin/HEAD left out', () => {
    const commits = parseGraphLog(LOG + record('x', '', 'refs/remotes/origin/HEAD', 'x'))
    expect(commits[0]?.refs).toEqual([
      { kind: 'local', name: 'main', isHead: true },
      { kind: 'remote', name: 'origin/main', isHead: false },
    ])
    expect(commits[1]?.refs.map(ref => ref.kind)).toEqual(['local', 'tag'])
    expect(commits[4]?.refs).toEqual([])
  })

  test('a merge opens a lane that joins back at the fork point', () => {
    const layout = layoutGraph(parseGraphLog(LOG))
    expect(layout.lanes).toBe(2)
    expect(layout.rows.map(row => row.lane)).toEqual([0, 1, 0, 0])
    expect(layout.rows[0]?.edges).toEqual(
      expect.arrayContaining([
        { from: 0, to: 1, color: 1 },
        { from: 0, to: 0, color: 0 },
      ]),
    )
    // The feature lane bends back into main at its parent.
    expect(layout.rows[1]?.edges).toEqual(
      expect.arrayContaining([
        { from: 0, to: 0, color: 0 },
        { from: 1, to: 0, color: 1 },
      ]),
    )
  })

  test('a badge escapes its name and dashes a remote', () => {
    const badge = renderBadge({ kind: 'remote', name: 'origin/<b>&"x"', isHead: false }, 0)
    expect(badge.source).toContain('origin/&#60;b&#62;&#38;&#34;x&#34;')
    expect(badge.source).toContain('stroke-dasharray')
    // The checked-out branch carries a check beside its branch icon: two Phosphor glyphs.
    expect(renderBadge({ kind: 'local', name: 'main', isHead: true }, 0).source.split('scale(0.046875)').length - 1).toBe(2)
  })

  test('strips meet: a lane leaving one row enters the next at the same x', () => {
    const layout = layoutGraph(parseGraphLog(LOG))
    const plain = { sync: null, syncAbove: null, hasWorkingAbove: false } as const
    // Row 0 (HEAD) opens lane 1 below its ring; row 1 takes it in from the top.
    expect(renderLaneStrip(layout, 0, plain)).toContain('M15 21C15')
    expect(renderLaneStrip(layout, 1, plain)).toContain('M31 0V14')
    // Row 1 bends its own lane back into main below its dot; row 2 takes it in.
    expect(renderLaneStrip(layout, 1, plain)).toContain('M31 14C31')
    expect(renderLaneStrip(layout, 2, plain)).toContain('M15 0V14')
  })

  test('the sync rail: green on the remote, amber and a hollow dot when local only', () => {
    const layout = layoutGraph(parseGraphLog(LOG))
    const remote = renderLaneStrip(layout, 2, { sync: 'remote', syncAbove: 'remote', hasWorkingAbove: false })
    const local = renderLaneStrip(layout, 2, { sync: 'local', syncAbove: 'remote', hasWorkingAbove: false })
    expect(remote).toContain('fill="#3fb950"')
    expect(local).toContain('fill="#d29922"')
    // A run that changes kind starts 2px down; a hollow dot stops the lines at its ring.
    expect(local).toContain('<rect x="0" y="2"')
    expect(local).toContain('M15 0V10')
    expect(local).toMatch(/r="3" fill="none"/)
  })

  test('a tag is drawn quiet: no outline', () => {
    const tag = renderBadge({ kind: 'tag', name: 'v1.4.6', isHead: false }, 3)
    expect(tag.source).not.toContain('<rect')
    expect(tag.source).toContain('#8b929c')
  })
})

describe('branches and details', () => {
  test('wrapText breaks at spaces and keeps blank lines', () => {
    expect(wrapText('one two three four\n\nfive', 9)).toEqual(['one two', 'three', 'four', '', 'five'])
  })

  test('a new branch is checked, then created and switched to', async () => {
    const git = fakeGit({ 'check-ref-format': { exitCode: 1 } })
    const repo = { root: 'C:/repo' } as RepoSnapshot
    expect(await createBranch(git.run, repo, '  ')).toEqual({ isOk: false, error: 'Type a branch name.' })
    expect(await createBranch(git.run, repo, 'bad name')).toEqual({
      isOk: false,
      error: '“bad name” is not a valid branch name.',
    })
    expect(git.calls.every(call => !call.argv.includes('switch'))).toBe(true)

    const ok = fakeGit({})
    expect(await createBranch(ok.run, repo, 'feature/x')).toEqual({ isOk: true, value: 'Created feature/x.' })
    expect(ok.calls[1]?.argv).toEqual(['git', 'switch', '-c', 'feature/x'])
  })

  test('refs: local branches, remote-only ones (no HEAD, no local twin), a signature', async () => {
    const stdout = [
      'a1 refs/heads/main',
      'a1 refs/remotes/origin/HEAD',
      'a1 refs/remotes/origin/main',
      'b2 refs/remotes/origin/staging',
      'c3 refs/tags/v1',
    ].join('\n')
    const refs = await loadRefs(fakeGit({ 'for-each-ref': { stdout } }).run, 'C:/repo')
    expect(refs.local).toEqual(['main'])
    expect(refs.remoteOnly).toEqual(['origin/staging'])
    expect(refs.signature).toBe(stdout)
  })

  test('unpushed commits come from rev-list --not --remotes', async () => {
    const git = fakeGit({ 'rev-list': { stdout: 'aaa\nbbb\n' } })
    expect(await loadUnpushed(git.run, 'C:/repo')).toEqual(['aaa', 'bbb'])
    expect(git.calls[0]?.argv).toEqual(expect.arrayContaining(['--not', '--remotes']))
  })

  const PANE = {
    component: 'Pane',
    requestId: 'git',
    props: {
      title: 'Git',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  } as const
  const OPEN = {
    command: 'git',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  } as const
  const GRAPH = [
    ['aaaaaaa1', 'bbbbbbb2', 'HEAD -> refs/heads/main', 'Local only work', 'Demo', '1760000000'],
    ['bbbbbbb2', '', 'refs/remotes/origin/main', 'Already on the web', 'Demo', '1759000000'],
  ]
    .map(fields => fields.join('\x1f') + '\x1e')
    .join('\n')
  const DETAIL = ['Demo', 'demo@example.com', '2026-10-17T11:12:03-03:00', 'Local only work\n\nBody line one.\nBody line two.\n'].join('\x1f')

  const answer = (stdout: string) => ({
    value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })

  test('pressing a commit opens its whole message; again closes it', async ($, on) => {
    on('session.cwd', () => ({ value: 'C:/repo' }))
    mock.store(on)
    on('clock.now', () => ({ value: 1_760_003_600_000 }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('process.run', (_$, e) => {
      const sub = e.argv.find((arg, i) => i > 0 && !arg.startsWith('-'))
      if (sub === 'rev-parse') return e.argv.includes('MERGE_HEAD') ? { value: { ...answer('').value, exitCode: 1 } } : answer('C:/repo\n')
      if (sub === 'status') {
        return answer('# branch.oid aaaaaaa1\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +1 -0\0')
      }
      if (sub === 'remote') return answer('origin\n')
      if (sub === 'for-each-ref') {
        return answer(e.argv.includes('refs/heads') ? 'main\n' : 'refs/remotes/origin/main\nrefs/remotes/origin/staging\n')
      }
      if (sub === 'rev-list') return answer('aaaaaaa1\n')
      if (sub === 'show') return answer(' src/a.ts | 4 ++--\n 1 file changed, 2 insertions(+), 2 deletions(-)\n')
      if (sub === 'log' && e.argv.some(arg => arg.includes('%B'))) return answer(DETAIL)
      if (sub === 'log' && e.argv.includes('--decorate=full')) return answer(GRAPH)

      return answer('aaaaaaa10000\x1faaaaaaa\x1fLocal only work\x1fDemo\x1f1760000000')
    })

    await $.command.run(OPEN)
    const ui = await $.ui.mount({ plugin: 'git-panel', surface: 'desktop', ...PANE })

    // The commit the remote holds is tinted; the local-only one is not.
    // The sync rail tells the commit the remote holds from the local-only one.
    const alts = (await ui.findAll({ type: 'Svg' })).map(svg => String(svg.props.alt))
    expect(alts).toContain('commit bbbbbbb, on remote')
    expect(alts).toContain('commit aaaaaaa, local only')
    expect(await ui.find({ text: /on remote/ })).toBeDefined()
    expect(await ui.find({ text: /Body line one/ })).toBeUndefined()

    await ui.press({ key: 'commit:aaaaaaa1' })
    expect(await ui.find({ text: /Body line one\./ })).toBeDefined()
    expect(await ui.find({ text: /1 file changed/ })).toBeDefined()
    expect(await ui.find({ key: 'copy-hash' })).toBeDefined()

    await ui.press({ key: 'close-commit' })
    expect(await ui.find({ text: /Body line one/ })).toBeUndefined()
  })

  test('New branch opens a field, Cancel closes it', async ($, on) => {
    on('session.cwd', () => ({ value: 'C:/repo' }))
    mock.store(on)
    on('clock.now', () => ({ value: 1_760_003_600_000 }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('process.run', (_$, e) => {
      const sub = e.argv.find((arg, i) => i > 0 && !arg.startsWith('-'))
      if (sub === 'rev-parse') return e.argv.includes('MERGE_HEAD') ? { value: { ...answer('').value, exitCode: 1 } } : answer('C:/repo\n')

      return answer(sub === 'status' ? '# branch.oid (initial)\0# branch.head main\0' : '')
    })

    await $.command.run(OPEN)
    const ui = await $.ui.mount({ plugin: 'git-panel', surface: 'desktop', ...PANE })
    expect(await ui.find({ key: 'new-branch-name' })).toBeUndefined()
    await ui.press({ key: 'new-branch' })
    expect(await ui.find({ key: 'new-branch-name' })).toBeDefined()
    await ui.press({ key: 'cancel-branch' })
    expect(await ui.find({ key: 'new-branch-name' })).toBeUndefined()
  })
})

describe('branches tab and merging', () => {
  const ROW_SEP = '\0'
  const BRANCH_LIST = [
    ['refs/heads/main', 'aaaaaaa', 'origin/main', 'ahead 2', '1760000000', 'Main work'],
    ['refs/heads/feature', 'bbbbbbb', '', '', '1759990000', 'Feature work'],
    ['refs/heads/old', 'ccccccc', 'origin/old', 'gone', '1750000000', 'Old work'],
    ['refs/remotes/origin/HEAD', 'ddddddd', '', '', '1759000000', 'Remote head'],
    ['refs/remotes/origin/main', 'ddddddd', '', '', '1759000000', 'Remote main'],
    ['refs/remotes/origin/staging', 'eeeeeee', '', '', '1758000000', 'Staging work'],
  ]
    .map(fields => fields.join(ROW_SEP))
    .join('\n')
  const MERGED = ['refs/heads/main', 'refs/heads/old', 'refs/remotes/origin/main'].join('\n')

  test('the branch list: tracking, merged, default, origin/HEAD left out', async () => {
    const git = fakeGit({ 'for-each-ref': { stdout: BRANCH_LIST }, 'symbolic-ref': { stdout: 'origin/main\n' } })
    // The merged list comes from a second for-each-ref: answer it by its flag.
    const run = async (argv: readonly string[], init?: RunInit) =>
      argv.some(arg => arg.startsWith('--merged'))
        ? { exitCode: 0, stdout: MERGED, stderr: '' }
        : git.run(argv, init)
    const list = await loadBranchList(run, 'C:/repo')

    expect(list.map(branch => branch.name)).toEqual(['main', 'feature', 'old', 'origin/main', 'origin/staging'])
    expect(list[0]).toEqual(
      expect.objectContaining({ kind: 'local', upstream: 'origin/main', ahead: 2, behind: 0, isMerged: true, isDefault: true }),
    )
    expect(list[1]).toEqual(expect.objectContaining({ upstream: null, isMerged: false, isDefault: false }))
    expect(list[2]).toEqual(expect.objectContaining({ isUpstreamGone: true }))
    expect(list[3]).toEqual(expect.objectContaining({ kind: 'remote', isDefault: true }))
  })

  test('deleting: -d for a merged branch, -D to force, push --delete on the remote', async () => {
    const git = fakeGit({})
    await deleteLocalBranch(git.run, 'C:/repo', 'old', false)
    await deleteLocalBranch(git.run, 'C:/repo', 'feature', true)
    await deleteRemoteBranch(git.run, 'C:/repo', 'origin/staging')

    expect(git.calls.map(call => call.argv)).toEqual([
      ['git', 'branch', '-d', '--', 'old'],
      ['git', 'branch', '-D', '--', 'feature'],
      ['git', 'push', 'origin', '--delete', 'staging'],
    ])
  })

  test('a merge with conflicts stays under way; another failure is an error', async () => {
    const conflicted = fakeGit({ merge: { exitCode: 1, stdout: 'CONFLICT (content)' } })
    expect(await mergeBranch(conflicted.run, 'C:/repo', 'feature')).toEqual({
      isOk: true,
      value: 'Merging feature: resolve the conflicts to finish.',
    })

    const refused = fakeGit({
      merge: { exitCode: 1, stderr: 'error: Your local changes would be overwritten by merge' },
      'rev-parse': { exitCode: 1 },
    })
    expect(await mergeBranch(refused.run, 'C:/repo', 'feature')).toEqual({
      isOk: false,
      error: 'error: Your local changes would be overwritten by merge',
    })
  })

  test('a file is marked resolved only once its markers are gone', async () => {
    const git = fakeGit({})
    const marked = await markResolved(git.run, 'C:/repo', 'a.ts', async () => 'x\n<<<<<<< HEAD\ny\n=======\nz\n>>>>>>> feature\n')
    expect(marked).toEqual({ isOk: false, error: 'a.ts still has conflict markers.' })
    expect(git.calls).toEqual([])

    expect(await markResolved(git.run, 'C:/repo', 'a.ts', async () => 'resolved\n')).toEqual({ isOk: true, value: '' })
    expect(git.calls[0]?.argv).toEqual(['git', '--literal-pathspecs', 'add', '--', 'a.ts'])
  })

  test('completing a merge waits for every conflict', async () => {
    const repo = {
      root: 'C:/repo',
      files: [{ path: 'a.ts', kind: 'conflict', isStaged: true }],
    } as unknown as RepoSnapshot
    expect(await completeMerge(fakeGit({}).run, repo)).toEqual({ isOk: false, error: 'Resolve every conflict first.' })
  })

  test('printable drops control characters, keeps tabs and line breaks', () => {
    expect(printable('a\u001b[31mred\u001b[0m\tb\nc\u0007')).toBe('a[31mred[0m\tb\nc')
  })

  const PANE = {
    component: 'Pane',
    requestId: 'git',
    props: {
      title: 'Git',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  } as const
  const OPEN = {
    command: 'git',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  } as const
  const answer = (stdout: string, exitCode = 0) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })

  /** A repository on main with a feature branch; `merging` puts a merge with one conflict under way. */
  function fakeRepo(on: On, merging: boolean) {
    on('session.cwd', () => ({ value: 'C:/repo' }))
    mock.store(on)
    on('clock.now', () => ({ value: 1_760_003_600_000 }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('process.run', (_$, e) => {
      const sub = e.argv.find((arg, i) => i > 0 && !arg.startsWith('-'))
      if (sub === 'rev-parse') {
        return e.argv.includes('MERGE_HEAD') ? answer(merging ? 'bbbbbbb\n' : '', merging ? 0 : 1) : answer('C:/repo\n')
      }
      if (sub === 'status') {
        const head = '# branch.oid aaaaaaa1\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -0\0'
        return answer(merging ? head + 'u UU N... 100644 100644 100644 100644 a b c src/a.ts\0' : head)
      }
      if (sub === 'remote') return answer('origin\n')
      if (sub === 'name-rev') return answer('feature\n')
      if (sub === 'show') return answer('Feature work\n')
      if (sub === 'symbolic-ref') return answer('origin/main\n')
      if (sub === 'rev-list') return answer(e.argv.includes('--count') ? '3\n' : '')
      if (sub === 'log' && e.argv.includes('--decorate=full')) {
        return answer(
          [
            ['aaaaaaa1', 'bbbbbbb2', 'HEAD -> refs/heads/main', 'Main work on the pager', 'Ana', '1760000000'],
            ['bbbbbbb2', '', 'refs/heads/feature', 'Feature work', 'Bruno', '1759990000'],
          ]
            .map(fields => fields.join('\x1f') + '\x1e')
            .join('\n'),
        )
      }
      if (sub === 'for-each-ref') {
        if (e.argv.some(arg => arg.startsWith('--merged'))) return answer(MERGED)
        if (e.argv.some(arg => arg.includes('upstream'))) return answer(BRANCH_LIST)

        return answer('aaaaaaa refs/heads/main\nbbbbbbb refs/heads/feature\n')
      }

      return answer('aaaaaaa10000\x1faaaaaaa\x1fMain work\x1fDemo\x1f1760000000')
    })
  }

  test('Branches: a branch opens its actions; Delete asks, saying what is lost', async ($, on) => {
    fakeRepo(on, false)
    await $.command.run(OPEN)
    const ui = await $.ui.mount({ plugin: 'git-panel', surface: 'desktop', ...PANE })

    await ui.press({ key: 'tab-branches' })
    expect(await ui.find({ text: /^Local · 3$/ })).toBeDefined()
    expect(await ui.find({ text: /^Remote · 2$/ })).toBeDefined()
    expect(await ui.find({ key: 'branch-delete' })).toBeUndefined()

    await ui.press({ key: 'branch:feature' })
    expect(await ui.find({ key: 'branch-switch' })).toBeDefined()
    await ui.press({ key: 'branch-delete' })
    expect(await ui.find({ text: /feature has commits that are not in main/ })).toBeDefined()
    expect((await ui.find({ key: 'confirm-yes' }))?.props.label).toBe('Delete anyway')
    await ui.press({ key: 'confirm-no' })
    expect(await ui.find({ key: 'confirm-yes' })).toBeUndefined()

    // The current branch offers no delete.
    await ui.press({ key: 'branch:main' })
    expect(await ui.find({ key: 'branch-delete' })).toBeUndefined()
    expect(await ui.find({ text: /The branch you are on/ })).toBeDefined()
  })

  test('Branches: the whole row is one target, with a hover tint; Delete is a labelled button', async ($, on) => {
    fakeRepo(on, false)
    await $.command.run(OPEN)
    const ui = await $.ui.mount({ plugin: 'git-panel', surface: 'desktop', ...PANE })

    await ui.press({ key: 'tab-branches' })
    // The hover tint rides the row as a style, beside its props.
    expect(JSON.stringify(await ui.drawn())).toContain('rgba(127, 127, 127, 0.07)')
    // The commit line opens the row as the name line does.
    await ui.press({ key: 'branch-commit:feature' })
    // An open row sits on its own surface.
    expect((await ui.findAll({ type: 'Box' })).some(box => box.props.backgroundColor !== undefined)).toBe(true)
    expect((await ui.find({ key: 'branch-delete' }))?.props.label).toBe('Delete…')
    await ui.press({ key: 'branch-commit:feature' })
    expect(await ui.find({ key: 'branch-delete' })).toBeUndefined()
  })

  test('Branches: Merge asks with the number of commits it brings in', async ($, on) => {
    fakeRepo(on, false)
    await $.command.run(OPEN)
    const ui = await $.ui.mount({ plugin: 'git-panel', surface: 'desktop', ...PANE })

    await ui.press({ key: 'tab-branches' })
    await ui.press({ key: 'branch:feature' })
    await ui.press({ key: 'branch-merge' })
    expect(await ui.find({ text: 'Merge 3 commits from feature into main? A merge commit records it.' })).toBeDefined()
    expect((await ui.find({ key: 'confirm-yes' }))?.props.label).toBe('Merge')
  })

  test('Branches filter: as you type, with a count; Clear brings every branch back', async ($, on) => {
    fakeRepo(on, false)
    await $.command.run(OPEN)
    const ui = await $.ui.mount({ plugin: 'git-panel', surface: 'desktop', ...PANE })

    await ui.press({ key: 'tab-branches' })
    await ui.input({ key: 'branch-filter', text: 'feat' })
    expect(await ui.find({ text: '1 of 5 branches match' })).toBeDefined()
    expect(await ui.find({ key: 'branch:feature' })).toBeDefined()
    expect(await ui.find({ key: 'branch:main' })).toBeUndefined()

    await ui.input({ key: 'branch-filter', text: 'nothing-like-this' })
    expect(await ui.find({ text: 'No branches match “nothing-like-this”.' })).toBeDefined()

    await ui.press({ key: 'branch-filter-clear' })
    expect(await ui.find({ key: 'branch:main' })).toBeDefined()
    expect(await ui.find({ key: 'branch-filter-clear' })).toBeUndefined()
  })

  test('History filter: matches as a flat list, the graph back once cleared', async ($, on) => {
    fakeRepo(on, false)
    await $.command.run(OPEN)
    const ui = await $.ui.mount({ plugin: 'git-panel', surface: 'desktop', ...PANE })

    expect(await ui.find({ key: 'commit:aaaaaaa1' })).toBeDefined()
    await ui.input({ key: 'history-filter', text: 'bruno' })
    expect(await ui.find({ text: '1 of 2 commits match' })).toBeDefined()
    expect(await ui.find({ key: 'commit:bbbbbbb2' })).toBeDefined()
    expect(await ui.find({ key: 'commit:aaaaaaa1' })).toBeUndefined()

    await ui.input({ key: 'history-filter', text: 'pager' })
    expect(await ui.find({ key: 'commit:aaaaaaa1' })).toBeDefined()
    // The matched word is set apart in the subject.
    expect(await ui.find({ type: 'Text', text: 'pager' })).toBeDefined()

    await ui.press({ key: 'history-filter-clear' })
    expect(await ui.find({ key: 'commit:bbbbbbb2' })).toBeDefined()
  })

  test('a merge under way: conflicts to mark resolved, abort, complete', async ($, on) => {
    fakeRepo(on, true)
    await $.command.run(OPEN)
    const ui = await $.ui.mount({ plugin: 'git-panel', surface: 'desktop', ...PANE })

    expect(await ui.find({ text: /^Merging feature · origin\/main/ })).toBeDefined()
    await ui.press({ key: 'tab-changes' })
    expect(await ui.find({ text: 'Merging feature into main' })).toBeDefined()
    expect(await ui.find({ key: 'resolve:src/a.ts' })).toBeDefined()
    expect(await ui.find({ key: 'abort-merge' })).toBeDefined()
    expect(await ui.find({ key: 'resolve-claude' })).toBeDefined()
    expect(await ui.find({ key: 'finish-merge' })).toBeDefined()
    // No checkboxes and no message field while merging.
    expect(await ui.find({ key: 'subject' })).toBeUndefined()
  })
})

describe('filter', () => {
  const commit = parseGraphLog(
    ['abc1234', '', 'refs/heads/feature/pager, tag: refs/tags/v2', 'Paginate the results', 'Ana Lima', '1760000000'].join('\x1f') +
      '\x1e',
  )[0]!

  test('terms are lower-case words; every one has to match', () => {
    expect(termsOf('  Pager  ANA ')).toEqual(['pager', 'ana'])
    expect(matchesCommit(commit, termsOf('paginate ana'))).toBe(true)
    expect(matchesCommit(commit, termsOf('paginate bruno'))).toBe(false)
  })

  test('a commit matches on subject, author, ref names, or the start of its hash', () => {
    expect(matchesCommit(commit, ['results'])).toBe(true)
    expect(matchesCommit(commit, ['lima'])).toBe(true)
    expect(matchesCommit(commit, ['feature/pager'])).toBe(true)
    expect(matchesCommit(commit, ['v2'])).toBe(true)
    expect(matchesCommit(commit, ['abc12'])).toBe(true)
    expect(matchesCommit(commit, ['1234'])).toBe(false)
  })

  test('a branch matches on name, upstream and last subject', () => {
    const branch = {
      name: 'feature/pager',
      kind: 'local',
      short: 'abc1234',
      upstream: 'origin/feature/pager',
      isUpstreamGone: false,
      ahead: 0,
      behind: 0,
      time: 0,
      subject: 'Paginate the results',
      isMerged: false,
      isDefault: false,
    } as const
    expect(matchesBranch(branch, ['pager'])).toBe(true)
    expect(matchesBranch(branch, ['results'])).toBe(true)
    expect(matchesBranch(branch, ['staging'])).toBe(false)
  })

  test('highlight marks every occurrence, overlaps merged', () => {
    expect(highlight('Pager pages', ['pag', 'ager'])).toEqual([
      { text: 'Pager', isMatch: true },
      { text: ' ', isMatch: false },
      { text: 'pag', isMatch: true },
      { text: 'es', isMatch: false },
    ])
  })
})

describe('trunk', () => {
  const record = (hash: string, parents: string, refs: string) =>
    [hash, parents, refs, `Commit ${hash}`, 'Demo', '1760000000'].join('\x1f') + '\x1e'

  test('a branch one commit ahead of main sits beside the trunk and joins it', () => {
    // testig (HEAD) -> main -> root: linear history, two branches.
    const commits = parseGraphLog(
      record('t', 'm', 'HEAD -> refs/heads/testig') + record('m', 'r', 'refs/heads/main') + record('r', '', ''),
    )
    expect(trunkTipOf(commits)).toBe('m')

    const layout = layoutGraph(commits, trunkTipOf(commits))
    expect(layout.rows.map(row => row.lane)).toEqual([1, 0, 0])
    expect(layout.rows[0]?.edges).toEqual([{ from: 1, to: 0, color: 1 }])
    // The trunk keeps its own colour.
    expect(layout.rows[1]?.color).toBe(0)
    expect(layout.rows[0]?.color).not.toBe(0)
  })

  test('without a trunk the old layout stands: one straight lane', () => {
    const commits = parseGraphLog(record('t', 'm', 'HEAD -> refs/heads/testig') + record('m', 'r', '') + record('r', '', ''))
    expect(layoutGraph(commits).rows.map(row => row.lane)).toEqual([0, 0, 0])
  })

  test('a merged branch: trunk straight in lane 0, the branch beside it', () => {
    const commits = parseGraphLog(
      record('m2', 'm1 f2', 'HEAD -> refs/heads/main') +
        record('f2', 'f1', 'refs/heads/feature') +
        record('f1', 'm1', '') +
        record('m1', 'r', '') +
        record('r', '', ''),
    )
    const layout = layoutGraph(commits, trunkTipOf(commits))
    expect(layout.rows.map(row => row.lane)).toEqual([0, 1, 1, 0, 0])
  })

  test('the trunk falls back to master, a remote main, then HEAD', () => {
    expect(trunkTipOf(parseGraphLog(record('a', '', 'refs/heads/master')))).toBe('a')
    expect(trunkTipOf(parseGraphLog(record('a', '', 'refs/remotes/origin/main')))).toBe('a')
    expect(trunkTipOf(parseGraphLog(record('a', '', 'HEAD -> refs/heads/work')))).toBe('a')
  })
})

describe('discard', () => {
  const PANE = {
    component: 'Pane',
    requestId: 'git',
    props: {
      title: 'Git',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  } as const
  const OPEN = {
    command: 'git',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  } as const
  const answer = (stdout: string, exitCode = 0) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })

  /** A repository with one modified and one untracked file; records every git call. */
  function fakeDirty(on: On) {
    const calls: string[][] = []
    on('session.cwd', () => ({ value: 'C:/repo' }))
    mock.store(on)
    on('clock.now', () => ({ value: 1_760_003_600_000 }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('process.run', (_$, e) => {
      calls.push([...e.argv])
      const sub = e.argv.find((arg, i) => i > 0 && !arg.startsWith('-'))
      if (sub === 'rev-parse') return e.argv.includes('MERGE_HEAD') ? answer('', 1) : answer('C:/repo\n')
      if (sub === 'status') {
        return answer(
          '# branch.oid aaaaaaa1\0# branch.head main\0' +
            '1 .M N... 100644 100644 100644 abc abc src/a.ts\0' +
            '? notes.md\0',
        )
      }
      if (sub === 'log' && !e.argv.includes('--decorate=full')) return answer('aaaaaaa10000\x1faaaaaaa\x1fWork\x1fDemo\x1f1760000000')

      return answer('')
    })

    return calls
  }

  test('Discard all asks first, naming what is deleted; Cancel keeps everything', async ($, on) => {
    const calls = fakeDirty(on)
    await $.command.run(OPEN)
    const ui = await $.ui.mount({ plugin: 'git-panel', surface: 'desktop', ...PANE })
    await ui.press({ key: 'tab-changes' })

    await ui.press({ key: 'discard-all' })
    expect(
      await ui.find({
        text: 'Discard all 2 changes? Changed files go back to the last commit and 1 untracked file is deleted. This cannot be undone.',
      }),
    ).toBeDefined()
    await ui.press({ key: 'discard-no' })
    expect(await ui.find({ key: 'discard-yes' })).toBeUndefined()
    expect(calls.some(argv => argv.includes('restore') || argv.includes('clean'))).toBe(false)
  })

  test('a row discards its own file once confirmed', async ($, on) => {
    const calls = fakeDirty(on)
    await $.command.run(OPEN)
    const ui = await $.ui.mount({ plugin: 'git-panel', surface: 'desktop', ...PANE })
    await ui.press({ key: 'tab-changes' })

    await ui.press({ key: 'discard:notes.md' })
    expect(await ui.find({ text: /Delete notes.md\? It was never committed/ })).toBeDefined()
    expect((await ui.find({ key: 'discard-yes' }))?.props.label).toBe('Delete file')

    await ui.press({ key: 'discard-yes' })
    expect(calls).toContainEqual(['git', 'clean', '-f', '-q', '--', 'notes.md'])
    expect(calls.some(argv => argv.includes('restore'))).toBe(false)
  })
})

describe('new branch name', () => {
  test('git rules, said before the name is submitted', () => {
    expect(branchNameProblem('', ['main'])).toBe(null)
    expect(branchNameProblem('feature/pager', ['main'])).toBe(null)
    expect(branchNameProblem('main', ['main'])).toBe('main already exists.')
    expect(branchNameProblem('my branch', [])).toMatch(/spaces/)
    expect(branchNameProblem('a..b', [])).toMatch(/two dots/)
    expect(branchNameProblem('feat:x', [])).toMatch(/cannot hold/)
    expect(branchNameProblem('-x', [])).toMatch(/cannot start/)
    expect(branchNameProblem('x.lock', [])).toMatch(/\.lock/)
  })
})
