import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement } from 'claude-code'

import type { BranchInfo, Confirm, RepoSnapshot } from '../../types'
import { askDelete, askMerge, cancelConfirm, confirmAction, switchTo, toggleBranch, trackRemote } from '../actions'
import { ago } from '../git'
import { ICON_COLOR, renderIcon } from '../graph'
import { matchesBranch, termsOf } from '../filter'
import { marked, renderFilterField } from './filter'
import type { Kit } from './kit'
import { plural, surfaced } from './kit'

// The state this file reads and writes; the scan lists atoms per file.
const branchList = atom({ plugin: 'git-panel', key: 'branchList' } as const, [])
const confirm = atom({ plugin: 'git-panel', key: 'confirm' } as const, null)
const openBranch = atom({ plugin: 'git-panel', key: 'openBranch' } as const, null)
const branchFilter = atom({ plugin: 'git-panel', key: 'branchFilter' } as const, '')

/** Where a branch stands, in words: against its upstream for a local one. */
function standing(branch: BranchInfo): { text: string; isWarning: boolean } {
  if (branch.kind === 'remote') {
    return { text: branch.short, isWarning: false }
  }
  if (branch.isUpstreamGone) {
    return { text: 'upstream deleted', isWarning: true }
  }
  if (branch.upstream === null) {
    return { text: 'not published', isWarning: false }
  }
  if (branch.ahead === 0 && branch.behind === 0) {
    return { text: 'up to date', isWarning: false }
  }
  const parts = [branch.ahead > 0 ? `${branch.ahead} to push` : '', branch.behind > 0 ? `${branch.behind} to pull` : '']

  return { text: parts.filter(Boolean).join(' · '), isWarning: false }
}

/** The question a destructive or merging action asks before it runs. */
function question(asked: NonNullable<Confirm>, branch: BranchInfo, current: string): { text: string; yes: string } {
  if (asked.action === 'merge') {
    const incoming = asked.incoming ?? 0

    return incoming === 0
      ? { text: `${current} already has every commit of ${branch.name}.`, yes: '' }
      : {
          text: `Merge ${plural(incoming, 'commit', 'commits')} from ${branch.name} into ${current}? A merge commit records it.`,
          yes: 'Merge',
        }
  }
  if (asked.action === 'delete-remote') {
    return {
      text: `Delete ${branch.name} on the remote? Everyone who uses it loses the branch.${branch.isDefault ? ' It is the remote’s default branch.' : ''}`,
      yes: 'Delete on remote',
    }
  }
  const lead = branch.isDefault ? `${branch.name} is a default branch. ` : ''

  return branch.isMerged
    ? { text: `${lead}Delete ${branch.name}? ${current} already has all of its commits.`, yes: 'Delete' }
    : {
        text: `${lead}${branch.name} has commits that are not in ${current}. Deleting it loses them unless another branch holds them.`,
        yes: 'Delete anyway',
      }
}

type RowContext = {
  snap: RepoSnapshot
  asked: Confirm
  now: number
  /** Remote branch names that have a local branch of the same name. */
  twins: Set<string>
  /** The filter's terms, marked where they occur. */
  terms: string[]
}

function row($: EngineInterface, kit: Kit, branch: BranchInfo, isOpen: boolean, context: RowContext): RenderElement {
  const { Box, Text, Button, Svg } = kit
  const { snap, asked, now } = context
  const current = snap.branch ?? 'HEAD'
  const isCurrent = branch.kind === 'local' && branch.name === snap.branch
  const isAsked = asked !== null && asked.branch === branch.name
  const isDirty = snap.files.some(file => file.kind !== 'untracked')
  const hasTwin = branch.kind === 'remote' && context.twins.has(branch.name.slice(branch.name.indexOf('/') + 1))
  const { text: state, isWarning } = standing(branch)
  const icon = branch.kind === 'remote' ? 'globe' : isCurrent ? 'current' : 'branch'

  return surfaced(
    kit,
    isOpen,
    <Box
      key={`branch-row:${branch.name}`}
      gap={1}
      alignItems="flex-start"
      paddingX={1}
      paddingY={isOpen ? 1 : 0}
      {...(isOpen ? {} : kit.hoverSurface)}
    >
      <Box flexShrink={0}>
        {Svg ? (
          <Svg
            source={renderIcon(icon, isCurrent ? ICON_COLOR.current : ICON_COLOR.muted)}
            alt={isCurrent ? 'current branch' : branch.kind === 'remote' ? 'remote branch' : 'local branch'}
            width={16}
            height={16}
          />
        ) : (
          <Text color={isCurrent ? 'success' : undefined} dimColor={!isCurrent}>
            {isCurrent ? '*' : ' '}
          </Text>
        )}
      </Box>

      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        {/* Both lines are one target: the name line and the commit line each open the row. */}
        <Button key={`branch:${branch.name}`} plain onPress={() => void toggleBranch($, branch.name)}>
          <Text weight={isCurrent || isOpen ? 'semibold' : 'regular'}>{marked(kit, branch.name, context.terms)}</Text>
          {isCurrent ? <Text dimColor> current</Text> : ''}
          <Text dimColor> · </Text>
          <Text color={isWarning ? 'warning' : undefined} dimColor={!isWarning}>
            {state}
          </Text>
        </Button>
        <Button key={`branch-commit:${branch.name}`} plain dimColor onPress={() => void toggleBranch($, branch.name)}>
          <Text size="footnote" wrap="truncate-end">
            {ago(branch.time, now)} · {marked(kit, branch.subject, context.terms)}
          </Text>
        </Button>

        {isOpen && !isAsked && (
          <Box marginTop={1}>
            {isCurrent ? (
              <Text size="footnote" dimColor>
                The branch you are on. Switch to another one to merge it elsewhere or delete it.
              </Text>
            ) : (
              <Box gap={1} flexWrap="wrap">
                {branch.kind === 'local' && (
                  <Button key="branch-switch" label="Switch to" onPress={() => void switchTo($, branch.name)} />
                )}
                {branch.kind === 'remote' && !hasTwin && (
                  <Button key="branch-track" label="Check out" onPress={() => void trackRemote($, branch.name)} />
                )}
                {snap.branch !== null && (
                  <Button key="branch-merge" label={`Merge into ${current}…`} onPress={() => void askMerge($, branch.name)} />
                )}
                <Button
                  key="branch-delete"
                  label={branch.kind === 'remote' ? 'Delete on remote…' : 'Delete…'}
                  onPress={() => void askDelete($, branch.name, branch.kind)}
                />
              </Box>
            )}
          </Box>
        )}

        {isOpen && isAsked && asked && (
          <Box flexDirection="column" gap={1} marginTop={1}>
            {(() => {
              const { text, yes } = question(asked, branch, current)
              const isBlocked = asked.action === 'merge' && isDirty && yes !== ''
              const isDestructive = asked.action !== 'merge'

              return (
                <Box flexDirection="column" gap={1}>
                  <Text size="footnote" color={isDestructive && !branch.isMerged ? 'warning' : undefined}>
                    {text}
                  </Text>
                  {isBlocked && (
                    <Text size="footnote" color="warning">
                      Commit or stash your changes first.
                    </Text>
                  )}
                  <Box gap={2} alignItems="center">
                    {yes !== '' && !isBlocked && (
                      <Button
                        key="confirm-yes"
                        variant={isDestructive ? 'secondary' : 'primary'}
                        label={yes}
                        onPress={() => void confirmAction($)}
                      />
                    )}
                    <Button
                      key="confirm-no"
                      plain
                      dimColor
                      label={yes === '' ? 'Close' : 'Cancel'}
                      onPress={() => void cancelConfirm($)}
                    />
                  </Box>
                </Box>
              )
            })()}
          </Box>
        )}
      </Box>
    </Box>
  ,
  )
}

/**
 * Every branch, local first, then remote: an icon, the name with where it
 * stands, its last commit under it. Pressing a name opens its actions on a
 * surface of its own; deleting and merging ask before they run.
 */
export async function renderBranches($: EngineInterface, kit: Kit, snap: RepoSnapshot, now: number): Promise<RenderElement> {
  const { Box, Text } = kit
  const list = await read($, branchList)
  const open = await read($, openBranch)
  const asked = await read($, confirm)
  const query = await read($, branchFilter)
  const terms = termsOf(query)
  const shown = terms.length > 0 ? list.filter(branch => matchesBranch(branch, terms)) : list
  const local = shown.filter(branch => branch.kind === 'local')
  const remote = shown.filter(branch => branch.kind === 'remote')
  const twins = new Set(list.filter(branch => branch.kind === 'local').map(branch => branch.name))
  const context: RowContext = { snap, asked, now, twins, terms }

  if (list.length === 0) {
    return (
      <Text size="footnote" dimColor>
        No branches yet: make the first commit.
      </Text>
    )
  }

  const section = (title: string, items: BranchInfo[]) =>
    items.length > 0 && (
      <Box flexDirection="column" gap={1}>
        <Text size="footnote" dimColor>
          <Text weight="semibold">{title}</Text> · {items.length}
        </Text>
        {items.map(branch => row($, kit, branch, open === branch.name, context))}
      </Box>
    )

  const field = renderFilterField(kit, {
    key: 'branch-filter',
    value: query,
    placeholder: 'Filter branches',
    onChange: value => void update($, branchFilter, () => value),
  })

  return (
    <Box flexDirection="column" gap={2}>
      {field && (
        <Box flexDirection="column" gap={1}>
          {field}
          {terms.length > 0 && (
            <Text size="footnote" dimColor>
              {shown.length === 0
                ? `No branches match “${query.trim()}”.`
                : `${shown.length} of ${plural(list.length, 'branch', 'branches')} match`}
            </Text>
          )}
        </Box>
      )}
      {section('Local', local)}
      {section('Remote', remote)}
    </Box>
  )
}
