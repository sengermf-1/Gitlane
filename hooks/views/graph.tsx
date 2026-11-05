import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement } from 'claude-code'

import type { CommitDetail, RepoSnapshot } from '../../types'
import { GRAPH_PAGE, showMore, toggleCommit } from '../actions'
import { ago } from '../git'
import {
  colorOf,
  ICON_COLOR,
  layoutGraph,
  trunkTipOf,
  renderBadge,
  renderIcon,
  renderLaneExtension,
  renderLaneStrip,
  renderRailSwatch,
  renderWorkingStrip,
  ROW,
  ROW_SPACER,
  stripWidth,
} from '../graph'
import type { GraphLayout, Sync } from '../graph'
import { matchesCommit, termsOf } from '../filter'
import { marked, renderFilterField } from './filter'
import type { Kit } from './kit'
import { iconElement, plural, surfaced } from './kit'

// The state this file reads and writes; the scan lists atoms per file.
const commitDetail = atom({ plugin: 'gitlane', key: 'detail' } as const, null)
const expanded = atom({ plugin: 'gitlane', key: 'expanded' } as const, null)
const graph = atom({ plugin: 'gitlane', key: 'graph' } as const, [])
const graphLimit = atom({ plugin: 'gitlane', key: 'graphLimit' } as const, GRAPH_PAGE)
const unpushed = atom({ plugin: 'gitlane', key: 'unpushed' } as const, [])
const view = atom({ plugin: 'gitlane', key: 'view' } as const, 'graph')
const historyFilter = atom({ plugin: 'gitlane', key: 'historyFilter' } as const, '')

// Refs drawn as badges on a row; the rest are counted.
const BADGES = 2
// Taller than any open row: the overlay is clipped to the row it sits in.
const EXTENSION = 2400

/** The legend of the sync rail, for the tab bar. */
export function renderLegend(kit: Kit): RenderElement | false {
  const { Box, Text, Svg } = kit
  if (!Svg) {
    return false
  }

  return (
    <Box gap={1} alignItems="center">
      <Svg source={renderRailSwatch('remote')} alt="on remote" width={4} height={14} />
      <Text size="footnote" dimColor>
        on remote
      </Text>
      <Svg source={renderRailSwatch('local')} alt="local only" width={4} height={14} />
      <Text size="footnote" dimColor>
        local only
      </Text>
    </Box>
  )
}

function details(kit: Kit, d: CommitDetail | null): RenderElement {
  const { Box, Text } = kit
  if (!d) {
    return (
      <Text size="footnote" dimColor>
        Loading…
      </Text>
    )
  }
  // The row already shows the subject; the details hold what it cuts off.
  const paragraphs = d.message
    .split(/\r?\n/)
    .slice(1)
    .join('\n')
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
  const [date = '', time = ''] = d.date.split('T')
  const [year, month, day] = date.split('-')

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={2} alignItems="center">
        <Box gap={1} alignItems="center">
          {iconElement(kit, renderIcon('user', ICON_COLOR.muted, 12), 'author', 12)}
          <Text size="footnote" dimColor>
            {d.author}
          </Text>
        </Box>
        <Box gap={1} alignItems="center">
          {iconElement(kit, renderIcon('clock', ICON_COLOR.muted, 12), 'date', 12)}
          <Text size="footnote" dimColor tabular>
            {year}-{month}-{day} {time.slice(0, 5)}
          </Text>
        </Box>
      </Box>
      {paragraphs.length > 0 && (
        <Box flexDirection="column" gap={1}>
          {paragraphs.map(paragraph => (
            <Text>{paragraph}</Text>
          ))}
        </Box>
      )}
      {d.files.length > 0 && (
        <Box flexDirection="column">
          {d.files.map(file => (
            <Text size="footnote" mono wrap="truncate-end">
              {file.trim()}
            </Text>
          ))}
          {d.moreFiles > 0 && (
            <Text size="footnote" dimColor>
              … and {plural(d.moreFiles, 'more file', 'more files')}
            </Text>
          )}
          <Text size="footnote" dimColor>
            {d.summary.trim()}
          </Text>
        </Box>
      )}
    </Box>
  )
}

/** Without SVG (the terminal): lanes as glyphs, refs in brackets. */
function textGraph(kit: Kit, layout: GraphLayout, now: number): RenderElement {
  const { Box, Text } = kit

  return (
    <Box flexDirection="column">
      {layout.rows.slice(0, 60).map(row => {
        const laneColor = new Map(row.edges.map(edge => [edge.from, edge.color]))
        laneColor.set(row.lane, row.color)

        return (
          <Box key={row.commit.hash}>
            {Array.from({ length: layout.lanes }, (_, k) => (
              <Text color={laneColor.has(k) ? colorOf(laneColor.get(k) ?? 0) : undefined}>
                {k === row.lane ? '● ' : laneColor.has(k) ? '│ ' : '  '}
              </Text>
            ))}
            {row.commit.refs.map(ref => (
              <Text color={ref.kind === 'tag' ? undefined : colorOf(row.color)} dimColor={ref.kind === 'tag'} bold={ref.isHead}>
                {ref.kind === 'remote' ? `(${ref.name})` : `[${ref.name}]`}{' '}
              </Text>
            ))}
            <Text wrap="truncate-end">{row.commit.subject}</Text>
            <Text dimColor> {ago(row.commit.time, now)}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * Every branch's history: one row per commit, its lanes and sync rail as an
 * SVG strip, its refs as badges, its subject and age as text the surface
 * draws itself. Pressing a subject opens the commit under its row.
 */
export async function renderGraph($: EngineInterface, kit: Kit, snap: RepoSnapshot, now: number): Promise<RenderElement> {
  const { Box, Text, Button, Svg } = kit
  const log = await read($, graph)
  const limit = await read($, graphLimit)

  if (log.length === 0) {
    return (
      <Text size="footnote" dimColor>
        No commits yet.
      </Text>
    )
  }

  const full = layoutGraph(log, trunkTipOf(log))
  const query = await read($, historyFilter)
  const terms = termsOf(query)
  const isFiltering = terms.length > 0
  // Filtered, lanes would join commits that are not shown: the matches are
  // drawn as a flat list instead, each dot keeping its lane's colour.
  const layout: GraphLayout = isFiltering
    ? {
        lanes: 1,
        rows: full.rows.filter(row => matchesCommit(row.commit, terms)).map(row => ({ ...row, lane: 0, edges: [] })),
      }
    : full

  const field = renderFilterField(kit, {
    key: 'history-filter',
    value: query,
    placeholder: 'Filter by message, author, hash or branch',
    onChange: value => void update($, historyFilter, () => value),
  })
  const isCut = log.length >= limit
  const summary = isFiltering && (
    <Box gap={2} alignItems="center">
      <Text size="footnote" dimColor>
        {layout.rows.length === 0
          ? `No commits match “${query.trim()}”${isCut ? ` in the latest ${log.length}` : ''}.`
          : `${layout.rows.length} of ${plural(log.length, 'commit', 'commits')} match${isCut ? ', the latest only' : ''}`}
      </Text>
      {isCut && <Button key="search-older" plain dimColor label="Search older commits" onPress={() => void showMore($)} />}
    </Box>
  )

  if (!Svg) {
    return (
      <Box flexDirection="column" gap={1}>
        {field}
        {summary}
        {textGraph(kit, layout, now)}
      </Box>
    )
  }

  const openHash = await read($, expanded)
  const opened = await read($, commitDetail)
  const local = new Set(await read($, unpushed))
  const hasRemote = snap.remotes.length > 0
  const laneWidth = stripWidth(layout.lanes)
  const syncOf = (index: number): Sync => {
    const row = layout.rows[index]
    if (!row || !hasRemote) {
      return null
    }

    return local.has(row.commit.hash) ? 'local' : 'remote'
  }
  const first = layout.rows[0]
  // The working tree joins the graph above HEAD when HEAD is the top row.
  const hasWorking =
    !isFiltering && snap.files.length > 0 && first !== undefined && first.commit.refs.some(ref => ref.isHead)

  return (
    <Box flexDirection="column">
      {field && <Box marginBottom={1}>{field}</Box>}
      {summary && <Box marginBottom={1}>{summary}</Box>}
      {!isFiltering && snap.files.length > 0 && (
        <Box alignItems="center">
          {hasWorking && first ? (
            <Svg source={renderWorkingStrip(layout, first.lane)} alt="uncommitted changes" width={laneWidth} height={ROW} />
          ) : (
            <Svg source={ROW_SPACER} alt="spacer" width={1} height={ROW} />
          )}
          <Button key="working" plain dimColor onPress={() => void update($, view, () => 'changes')}>
            <Text italic>{plural(snap.files.length, 'uncommitted change', 'uncommitted changes')}</Text>
          </Button>
        </Box>
      )}

      {layout.rows.map((row, i) => {
        const hash = row.commit.hash
        const isOpen = openHash === hash
        const isHead = row.commit.refs.some(ref => ref.isHead)
        const sync = syncOf(i)
        const refs = row.commit.refs
        const hidden = refs.length - BADGES

        return surfaced(
          kit,
          isOpen,
          <Box key={hash} position="relative" overflow="hidden" alignItems="flex-start" {...(isOpen ? {} : kit.hoverSurface)}>
            {isOpen && (
              <Box position="absolute" top={0} left={0} bottom={0} overflow="hidden">
                <Svg
                  source={renderLaneExtension(layout, i, sync, EXTENSION)}
                  alt="the graph continues"
                  width={laneWidth}
                  height={EXTENSION}
                />
              </Box>
            )}
            <Box flexShrink={0}>
              <Svg
                source={renderLaneStrip(layout, i, {
                  sync,
                  syncAbove: i === 0 ? null : syncOf(i - 1),
                  hasWorkingAbove: i === 0 && hasWorking,
                })}
                alt={`commit ${hash.slice(0, 7)}${sync === 'local' ? ', local only' : sync === 'remote' ? ', on remote' : ''}`}
                width={laneWidth}
                height={ROW}
              />
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              <Box alignItems="center">
                <Svg source={ROW_SPACER} alt="spacer" width={1} height={ROW} />
                {refs.slice(0, BADGES).map(ref => {
                  const badge = renderBadge(ref, row.color)

                  return (
                    <Box flexShrink={0}>
                      <Svg source={badge.source} alt={ref.name} width={badge.width} height={ROW} />
                    </Box>
                  )
                })}
                {hidden > 0 && (
                  <Box flexShrink={0} marginRight={1}>
                    <Text size="footnote" dimColor>
                      +{hidden}
                    </Text>
                  </Box>
                )}
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Button key={`commit:${hash}`} plain onPress={() => void toggleCommit($, hash)}>
                    <Text wrap="truncate-end" weight={isHead || isOpen ? 'semibold' : 'regular'}>
                      {marked(kit, row.commit.subject, terms)}
                    </Text>
                  </Button>
                </Box>
                <Box flexShrink={0} marginLeft={1}>
                  <Text size="footnote" dimColor tabular>
                    {hash.slice(0, 7)} · {ago(row.commit.time, now)}
                  </Text>
                </Box>
              </Box>
              {isOpen && (
                <Box flexDirection="column" gap={1} paddingBottom={1} paddingRight={1}>
                  {details(kit, opened?.hash === hash ? opened : null)}
                  <Box gap={1}>
                    <Button
                      key="copy-hash"
                      dimColor
                      label="Copy hash"
                      onPress={press => {
                        void $.ui.copy({ text: hash, surface: press.surface })
                        $.ui.toast('Hash copied.')
                      }}
                    />
                    <Button key="close-commit" dimColor label="Close" onPress={() => void toggleCommit($, hash)} />
                  </Box>
                </Box>
              )}
            </Box>
          </Box>,
        )
      })}

      {isCut && !isFiltering && (
        <Box marginTop={1}>
          <Button key="more" dimColor label="Show older commits" onPress={() => void showMore($)} />
        </Box>
      )}
    </Box>
  )
}
