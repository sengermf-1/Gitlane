import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement } from 'claude-code'

import type { Busy, RepoSnapshot } from '../../types'
import { dismissNotice, fetchAll, makeBranch, pull, push, switchTo, trackRemote } from '../actions'
import { ago, publishRemote } from '../git'
import { ICON_COLOR, renderIcon, SYNC_COLOR } from '../graph'
import type { IconName } from '../graph'
import type { Kit } from './kit'
import { iconElement, plural, surfaced } from './kit'

// The state this file reads and writes; the scan lists atoms per file.
const branches = atom({ plugin: 'git-panel', key: 'branches' } as const, [])
const busy = atom({ plugin: 'git-panel', key: 'busy' } as const, null)
const newBranch = atom({ plugin: 'git-panel', key: 'newBranch' } as const, null)
const notice = atom({ plugin: 'git-panel', key: 'notice' } as const, null)
const remoteBranches = atom({ plugin: 'git-panel', key: 'remoteBranches' } as const, [])

const BUSY_LABEL: Record<Exclude<Busy, null>, string> = {
  suggest: 'Writing a message…',
  commit: 'Committing…',
  push: 'Pushing…',
  pull: 'Pulling…',
  fetch: 'Fetching…',
  switch: 'Switching branch…',
  create: 'Creating the branch…',
  delete: 'Deleting the branch…',
  merge: 'Merging…',
  abort: 'Aborting the merge…',
  resolve: 'Marking it resolved…',
  discard: 'Discarding…',
  init: 'Creating the repository…',
}

// A detached HEAD is no branch to pick; it stands as its own option.
const DETACHED = '\u0000detached'
const REMOTE = 'remote:'

/** What is wrong with a branch name, in a sentence; null when git would take it. */
export function branchNameProblem(name: string, existing: readonly string[]): string | null {
  const clean = name.trim()
  if (clean === '') {
    return null
  }
  if (existing.includes(clean)) {
    return `${clean} already exists.`
  }
  if (/\s/.test(clean)) {
    return 'Branch names cannot hold spaces; use - or / instead.'
  }
  if (/[~^:?*[\\\x00-\x1f\x7f]/.test(clean) || clean.includes('..') || clean.includes('@{')) {
    return 'Branch names cannot hold ~ ^ : ? * [ \\ or two dots in a row.'
  }
  if (/^[-/.]|[/.]$|\.lock$|\/\//.test(clean) || clean === '@') {
    return 'A branch name cannot start with - / or ., end with / . or .lock, or hold //.'
  }

  return null
}

/** One sentence on where the branch stands against its remote. */
function syncSentence(snap: RepoSnapshot, now: number): string {
  const parts: string[] = []
  if (snap.merge) {
    parts.push(`Merging ${snap.merge.source}`)
  }
  if (snap.remotes.length === 0) {
    parts.push('No remote configured')
  } else if (snap.isUpstreamGone) {
    parts.push(`${snap.upstream} was deleted on the remote`)
  } else if (snap.upstream === null) {
    parts.push(snap.branch === null ? 'Detached HEAD' : 'Local branch, not published yet')
  } else if (snap.ahead === 0 && snap.behind === 0) {
    parts.push(`Up to date with ${snap.upstream}`)
  } else {
    parts.push(snap.upstream)
    if (snap.ahead > 0) {
      parts.push(`${plural(snap.ahead, 'commit', 'commits')} to push`)
    }
    if (snap.behind > 0) {
      parts.push(`${snap.behind} to pull`)
    }
  }
  if (snap.lastPushed) {
    parts.push(`last push ${snap.lastPushed.short} ${ago(snap.lastPushed.time, now)}`)
  }

  return parts.join(' · ')
}

/**
 * The branch bar: the branch picker and a new-branch action on the left,
 * the remote actions on the right, one line of status under them; a failure
 * stays below until dismissed.
 */
export async function renderHeader($: EngineInterface, kit: Kit, snap: RepoSnapshot, now: number): Promise<RenderElement> {
  const { Box, Text, Button, Input, Select } = kit
  const names = await read($, branches)
  const remoteOnly = await read($, remoteBranches)
  const creating = await read($, newBranch)
  const working = await read($, busy)
  const note = await read($, notice)

  const hasRemote = snap.remotes.length > 0
  const isPublish = snap.upstream === null || snap.isUpstreamGone
  const canPush = snap.branch !== null && snap.head !== null && (isPublish ? publishRemote(snap) !== null : true)
  const options = [
    ...(snap.branch === null ? [{ value: DETACHED, label: 'Detached HEAD' }] : []),
    ...names.map(name => ({ value: name, label: name })),
    ...remoteOnly.map(ref => ({ value: `${REMOTE}${ref}`, label: `${ref} (remote)` })),
  ]

  return (
    <Box flexDirection="column" gap={1}>
      <Box justifyContent="space-between" alignItems="center" gap={1}>
        <Box gap={2} alignItems="center">
          {Select && options.length > 0 ? (
            <Select
              key="branch"
              options={options}
              value={snap.branch ?? DETACHED}
              onSelect={value => {
                if (value.startsWith(REMOTE)) {
                  void trackRemote($, value.slice(REMOTE.length))
                } else if (value !== DETACHED) {
                  void switchTo($, value)
                }
              }}
            />
          ) : (
            <Text weight="semibold">{snap.branch ?? 'Detached HEAD'}</Text>
          )}
          {Input && creating === null && (
            <Button key="new-branch" plain dimColor label="New branch" onPress={() => void update($, newBranch, () => '')} />
          )}
        </Box>
        <Box gap={2} alignItems="center">
          {hasRemote && <Button key="fetch" plain dimColor label="Fetch" onPress={() => void fetchAll($)} />}
          {hasRemote && !isPublish && (
            <Button key="pull" plain dimColor label={snap.behind > 0 ? `Pull ${snap.behind}` : 'Pull'} onPress={() => void pull($)} />
          )}
          {canPush &&
            // The pane's one accent, and only when there is something to send.
            (isPublish || snap.ahead > 0 ? (
              <Button
                key="push"
                variant="primary"
                label={isPublish ? 'Publish' : `Push ${snap.ahead}`}
                onPress={() => void push($)}
              />
            ) : (
              <Button key="push" plain dimColor label="Push" onPress={() => void push($)} />
            ))}
        </Box>
      </Box>

      {Input &&
        creating !== null &&
        // One field on its own surface: where the branch starts, said under it;
        // the field's Enter control creates it, so no second Create beside it.
        surfaced(
          kit,
          true,
        <Box flexDirection="column" gap={1} padding={1}>
          <Box gap={1} alignItems="center">
            {iconElement(kit, renderIcon('branch', ICON_COLOR.muted, 16), 'new branch', 16)}
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Input
                key="new-branch-name"
                placeholder="New branch name"
                value={creating}
                autoFocus
                submitLabel="Create"
                onInput={value => void update($, newBranch, () => value)}
                onSubmit={value => void makeBranch($, value)}
              />
            </Box>
            <Button key="cancel-branch" plain dimColor label="Cancel" onPress={() => void update($, newBranch, () => null)} />
          </Box>
          {(() => {
            const problem = branchNameProblem(creating, names)

            return (
              <Text size="footnote" color={problem ? 'warning' : undefined} dimColor={!problem}>
                {problem ?? `Starts from ${snap.branch ?? 'HEAD'}${snap.head ? ` at ${snap.head.short}` : ''}, with your changes kept.`}
              </Text>
            )
          })()}
        </Box>,
        )}

      <Box gap={1} alignItems="center">
        {(() => {
          const [icon, color]: [IconName, string] | [null, null] = working
            ? ['spinner', ICON_COLOR.muted]
            : snap.merge
              ? ['merge', SYNC_COLOR.local]
              : snap.remotes.length === 0 || snap.upstream === null || snap.isUpstreamGone
                ? ['branch', ICON_COLOR.muted]
                : snap.ahead > 0
                  ? ['arrowUp', SYNC_COLOR.local]
                  : snap.behind > 0
                    ? ['arrowDown', ICON_COLOR.accent]
                    : ['cloudCheck', SYNC_COLOR.remote]

          return icon && iconElement(kit, renderIcon(icon, color, 14, working !== null), working ? 'working' : 'sync state')
        })()}
        <Text size="footnote" dimColor wrap="truncate-end">
          {working ? BUSY_LABEL[working] : syncSentence(snap, now)}
        </Text>
      </Box>

      {note && (
        <Box gap={1} alignItems="center" justifyContent="space-between">
          <Text color="error" size="footnote">
            {note.text}
          </Text>
          <Button key="dismiss" plain dimColor label="Dismiss" onPress={() => void dismissNotice($)} />
        </Box>
      )}
    </Box>
  )
}
