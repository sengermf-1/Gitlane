import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement } from 'claude-code'

import type { FileChange, FileKind, RepoSnapshot } from '../../types'
import { abort, askDiscard, cancelDiscard, commit, confirmDiscard, finishMerge, resolve, resolveWithClaude, suggestAndCommit } from '../actions'
import { FILE_ICON, ICON_COLOR, renderIcon } from '../graph'
import type { Kit } from './kit'
import { iconElement, plural, surfaced } from './kit'

// The state this file reads and writes; the scan lists atoms per file.
const body = atom({ plugin: 'gitlane', key: 'body' } as const, '')
const excluded = atom({ plugin: 'gitlane', key: 'excluded' } as const, [])
const subject = atom({ plugin: 'gitlane', key: 'subject' } as const, '')
const discardAsk = atom({ plugin: 'gitlane', key: 'discardAsk' } as const, null)

const MARK: Record<FileKind, { letter: string; color: string }> = {
  modified: { letter: 'M', color: 'warning' },
  added: { letter: 'A', color: 'success' },
  deleted: { letter: 'D', color: 'error' },
  renamed: { letter: 'R', color: 'suggestion' },
  untracked: { letter: 'U', color: 'success' },
  conflict: { letter: '!', color: 'error' },
}

/** A path as its folder (muted) and its name, the folder cut from the left to fit. */
function splitPath(path: string, room: number): { folder: string; name: string } {
  const at = path.lastIndexOf('/')
  const name = path.slice(at + 1)
  let folder = at < 0 ? '' : path.slice(0, at + 1)
  const left = Math.max(0, room - name.length)
  if (folder.length > left) {
    folder = left > 2 ? `…${folder.slice(folder.length - left + 1)}` : '…/'
  }

  return { folder, name }
}

/** A file's status letter, folder and name: the text of its row. */
function fileLabel(kit: Kit, file: FileChange, room: number): RenderElement[] {
  const { Text } = kit
  const mark = MARK[file.kind]
  const { folder, name } = splitPath(file.path, room)

  return [
    // With SVG the row's icon says the kind; the letter is the terminal's.
    ...(kit.Svg ? [] : [<Text color={mark.color}>{mark.letter}</Text>, <Text> </Text>]),
    <Text dimColor>{folder}</Text>,
    <Text>{name}</Text>,
    ...(file.origPath ? [<Text dimColor> ← {file.origPath}</Text>] : []),
  ]
}

/**
 * A merge under way: its conflicts first, each pressed once resolved (the
 * file is checked for markers), the rest as they will be committed; then
 * finish or abort.
 */
function mergeForm($: EngineInterface, kit: Kit, snap: RepoSnapshot, room: number): RenderElement {
  const { Box, Text, Button } = kit
  const merge = snap.merge!
  const conflicts = snap.files.filter(file => file.kind === 'conflict')
  const others = snap.files.filter(file => file.kind !== 'conflict')

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box gap={1} alignItems="center">
          {iconElement(kit, renderIcon('merge', FILE_ICON.modified.color, 16), 'merge', 16)}
          <Text weight="semibold">
            Merging {merge.source} into {snap.branch ?? 'HEAD'}
          </Text>
        </Box>
        <Text size="footnote" dimColor>
          {conflicts.length > 0
            ? `${plural(conflicts.length, 'file has', 'files have')} conflicts. Fix each one, then press it to mark it resolved.`
            : 'Every conflict is resolved. Complete the merge to record it.'}
        </Text>
      </Box>

      {conflicts.length > 0 && (
        <Box flexDirection="column">
          {conflicts.map(file => (
            <Box key={`conflict:${file.path}`} justifyContent="space-between" alignItems="center" gap={1}>
              <Box flexShrink={1} minWidth={0} gap={1} alignItems="center">
                {iconElement(kit, renderIcon('conflict', FILE_ICON.conflict.color), 'conflict')}
                <Text wrap="truncate-start">{fileLabel(kit, file, room - 16)}</Text>
              </Box>
              <Button key={`resolve:${file.path}`} dimColor label="Mark resolved" onPress={() => void resolve($, file.path)} />
            </Box>
          ))}
        </Box>
      )}

      {others.length > 0 && (
        <Box flexDirection="column">
          <Text size="footnote" dimColor>
            In the merge commit · {others.length}
          </Text>
          {others.map(file => (
            <Text key={`merged:${file.path}`} wrap="truncate-start">
              {fileLabel(kit, file, room)}
            </Text>
          ))}
        </Box>
      )}

      <Box gap={1} justifyContent="flex-end">
        <Button key="abort-merge" dimColor label="Abort merge" onPress={() => void abort($)} />
        {conflicts.length > 0 && (
          <Button key="resolve-claude" dimColor label="Resolve with Claude" onPress={() => void resolveWithClaude($)} />
        )}
        <Button key="finish-merge" variant="primary" label="Complete merge" onPress={() => void finishMerge($)} />
      </Box>
    </Box>
  )
}

/**
 * The commit form: the message, the commit and a commit with Claude's
 * message on top, then every change with a checkbox (all on by default).
 * During a merge, the merge's own form instead.
 */
export async function renderChanges($: EngineInterface, kit: Kit, snap: RepoSnapshot, columns: number): Promise<RenderElement> {
  const { Box, Text, Button, Input, Svg } = kit
  const room = Math.max(20, columns - 8)

  if (snap.merge) {
    return mergeForm($, kit, snap, room)
  }

  const skip = new Set(await read($, excluded))
  const chosen = snap.files.filter(file => !skip.has(file.path))
  const title = await read($, subject)
  const detail = await read($, body)
  const asked = await read($, discardAsk)
  // Where a pointer can hover, a row's Discard waits for it; elsewhere it stays in view.
  const canHover = 'hover' in kit.hoverSurface
  const untracked = snap.files.filter(file => file.kind === 'untracked').length
  const commitLabel = chosen.length > 0 ? `Commit ${plural(chosen.length, 'file', 'files')}` : 'Commit'
  // A graphical surface draws the field's submit as a button beside it: that
  // button is the commit, so no second Commit below.
  const fieldCommits = Input !== undefined && canHover
  // With a message written, Commit is the main press; without one, Claude's.
  const hasTitle = title.trim() !== ''

  /** The question before a discard: what goes, and that it cannot come back. */
  const confirmRow = (key: string, text: string, yes: string) => (
    <Box key={key} flexDirection="column" gap={1} padding={1}>
      <Text size="footnote" color="warning">
        {text}
      </Text>
      <Box gap={2} alignItems="center">
        <Button key="discard-yes" label={yes} onPress={() => void confirmDiscard($)} />
        <Button key="discard-no" plain dimColor label="Cancel" onPress={() => void cancelDiscard($)} />
      </Box>
    </Box>
  )

  if (snap.files.length === 0) {
    return (
      <Text size="footnote" dimColor>
        Nothing to commit: the working tree is clean.
      </Text>
    )
  }

  return (
    <Box flexDirection="column" gap={2}>
      <Box flexDirection="column" gap={1}>
        {/* One row: the message takes the room, the two commits close it. */}
        <Box gap={1} alignItems="center" flexWrap="wrap">
          <Box flexGrow={1} minWidth={24}>
            {Input ? (
              <Input
                key="subject"
                placeholder="Commit message"
                value={title}
                submitLabel={commitLabel}
                onInput={value => void update($, subject, () => value)}
                onSubmit={value => {
                  void (async () => {
                    await update($, subject, () => value)
                    await commit($)
                  })()
                }}
              />
            ) : (
              <Text>{title || <Text dimColor>No message</Text>}</Text>
            )}
          </Box>
          {!fieldCommits && (
            <Button key="commit" {...(hasTitle ? { variant: 'primary' } : {})} label={commitLabel} onPress={() => void commit($)} />
          )}
          {/* Claude writes the message and the commit follows: one press. */}
          <Button
            key="suggest-commit"
            {...(hasTitle ? { dimColor: true } : { variant: 'primary' })}
            label="✦ Suggest & commit"
            onPress={() => void suggestAndCommit($)}
          />
        </Box>
        {detail && (
          <Box flexDirection="column">
            <Text size="footnote" dimColor>
              {detail}
            </Text>
            <Button key="clear-body" plain dimColor label="Remove description" onPress={() => void update($, body, () => '')} />
          </Box>
        )}
      </Box>

      <Box flexDirection="column">
        <Box justifyContent="space-between" alignItems="center">
          <Text size="footnote" dimColor>
            {/* The tab already counts the changes; this line speaks of the selection. */}
            {chosen.length === snap.files.length ? 'All selected' : `${chosen.length} of ${snap.files.length} selected`}
          </Text>
          <Box gap={2}>
            <Button key="all" plain dimColor label="Select all" onPress={() => void update($, excluded, () => [])} />
            <Button
              key="none"
              plain
              dimColor
              label="Select none"
              onPress={() => void update($, excluded, () => snap.files.map(file => file.path))}
            />
            <Button key="discard-all" plain dimColor label="Discard all…" onPress={() => void askDiscard($, '*')} />
          </Box>
        </Box>
        {asked === '*' &&
          surfaced(
            kit,
            true,
            confirmRow(
            'discard-all-confirm',
            `Discard all ${plural(snap.files.length, 'change', 'changes')}? Changed files go back to the last commit${
              untracked > 0 ? ` and ${plural(untracked, 'untracked file is', 'untracked files are')} deleted` : ''
            }. This cannot be undone.`,
            'Discard all',
            ),
          )}
        {snap.files.map(file => {
          const isOn = !skip.has(file.path)

          const toggle = () =>
            void update($, excluded, list =>
              list.includes(file.path) ? list.filter(path => path !== file.path) : [...list, file.path],
            )

          const isAsked = asked === file.path

          // An asked row and its question share one surface.
          return surfaced(
            kit,
            isAsked,
            <Box key={`file-block:${file.path}`} flexDirection="column">
              <Box key={`file-row:${file.path}`} gap={1} alignItems="center" {...(isAsked ? {} : kit.hoverSurface)}>
                {Svg && (
                  <Svg
                    source={renderIcon(isOn ? 'checkboxOn' : 'checkboxOff', isOn ? ICON_COLOR.accent : ICON_COLOR.muted)}
                    alt={isOn ? 'in the commit' : 'left out'}
                    width={16}
                    height={16}
                  />
                )}
                {iconElement(kit, renderIcon(FILE_ICON[file.kind].icon, FILE_ICON[file.kind].color), file.kind)}
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Button key={`file:${file.path}`} plain dimColor={!isOn} onPress={toggle}>
                    {Svg ? '' : isOn ? '[x] ' : '[ ] '}
                    {fileLabel(kit, file, room)}
                  </Button>
                </Box>
                <Box flexShrink={0} {...(canHover && !isAsked ? { display: 'none', hover: { display: 'flex' } } : {})}>
                  <Button key={`discard:${file.path}`} plain dimColor label="Discard…" onPress={() => void askDiscard($, file.path)} />
                </Box>
              </Box>
              {isAsked &&
                confirmRow(
                  `discard-confirm:${file.path}`,
                  file.kind === 'untracked'
                    ? `Delete ${file.path}? It was never committed, so it cannot be brought back.`
                    : `Discard the changes to ${file.path}? It goes back to the last commit. This cannot be undone.`,
                  file.kind === 'untracked' ? 'Delete file' : 'Discard',
                )}
            </Box>,
          )
        })}
      </Box>
    </Box>
  )
}
