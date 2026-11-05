export type CommitInfo = {
  hash: string
  short: string
  subject: string
  author: string
  /** Commit time, ms since the epoch. */
  time: number
}

export type FileKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflict'

export type FileChange = {
  path: string
  /** The path before a rename or copy. */
  origPath?: string
  kind: FileKind
  /** True when the index already holds a change for this path. */
  isStaged: boolean
}

export type RepoSnapshot = {
  kind: 'repo'
  root: string
  /** Branch name; null on a detached HEAD. */
  branch: string | null
  upstream: string | null
  isUpstreamGone: boolean
  ahead: number
  behind: number
  /** Null before the first commit. */
  head: CommitInfo | null
  /** The upstream's tip: the last commit known to be pushed. */
  lastPushed: CommitInfo | null
  remotes: string[]
  files: FileChange[]
  /** A merge under way (MERGE_HEAD set), or null. */
  merge: MergeState | null
}

export type MergeState = {
  /** The branch being merged, as name-rev names MERGE_HEAD. */
  source: string
  /** The merged tip's subject. */
  subject: string
}

export type BranchInfo = {
  /** `main` for a local branch, `origin/main` for a remote one. */
  name: string
  kind: 'local' | 'remote'
  short: string
  upstream: string | null
  isUpstreamGone: boolean
  ahead: number
  behind: number
  /** Tip commit time, ms since the epoch. */
  time: number
  subject: string
  /** HEAD already holds every commit of it: deleting it loses nothing. */
  isMerged: boolean
  /** main, master or the remote's default branch. */
  isDefault: boolean
}

/** A destructive or history-changing action waiting for a second press. */
export type Confirm = {
  action: 'delete' | 'delete-remote' | 'merge'
  branch: string
  /** For a merge: commits it brings in. */
  incoming?: number
} | null

export type GitSnapshot =
  | RepoSnapshot
  | { kind: 'no-git'; cwd: string }
  | { kind: 'no-binary'; cwd: string }
  | { kind: 'error'; cwd: string; message: string }

export type GraphRef = {
  kind: 'local' | 'remote' | 'tag' | 'detached'
  name: string
  /** True for the checked-out branch (or a detached HEAD). */
  isHead: boolean
}

export type GraphCommit = {
  hash: string
  parents: string[]
  refs: GraphRef[]
  subject: string
  author: string
  /** Commit time, ms since the epoch. */
  time: number
}

export type CommitDetail = {
  hash: string
  author: string
  email: string
  /** ISO 8601 author date. */
  date: string
  /** The whole message, subject and body. */
  message: string
  /** `git show --stat` lines, one per file. */
  files: string[]
  moreFiles: number
  summary: string
}

export type View = 'graph' | 'changes' | 'branches'

export type Busy = 'suggest' | 'commit' | 'push' | 'pull' | 'fetch' | 'switch' | 'create' | 'delete' | 'merge' | 'abort' | 'resolve' | 'discard' | 'init' | null

export type Notice = { kind: 'ok' | 'error'; text: string } | null

declare module 'claude-code' {
  interface PluginState {
    'git-panel': {
      snapshot: GitSnapshot | null
      /** Paths left out of the next commit; everything else is selected. */
      excluded: string[]
      subject: string
      body: string
      busy: Busy
      notice: Notice
      view: View
      /** Commits of every branch, newest first, as the graph draws them. */
      graph: GraphCommit[]
      graphLimit: number
      /** Local branch names. */
      branches: string[]
      /** Remote branches with no local one, as `origin/name`. */
      remoteBranches: string[]
      /** Hashes of commits no remote branch holds yet. */
      unpushed: string[]
      /** The commit whose row is open, if any. */
      expanded: string | null
      detail: CommitDetail | null
      /** The name being typed for a new branch; null when not creating. */
      newBranch: string | null
      /** Every branch for the Branches tab. */
      branchList: BranchInfo[]
      /** The branch whose actions are open in the Branches tab. */
      openBranch: string | null
      confirm: Confirm
      /** What the History tab is filtered by; empty shows the whole graph. */
      historyFilter: string
      /** What the Branches tab is filtered by. */
      branchFilter: string
      /** A discard waiting for its confirmation: one file's path, '*' for every change. */
      discardAsk: string | null
    }
  }
}
