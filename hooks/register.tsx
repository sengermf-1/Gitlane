import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { View } from '../types'
import { discardAll, init, push, refresh, refreshSoon, suggestAndCommit } from './actions'
import { renderBranches } from './views/branches'
import { renderChanges } from './views/changes'
import { renderGraph, renderLegend } from './views/graph'
import { renderHeader } from './views/header'
import type { Kit } from './views/kit'
import { hoverSurfaceFor, openSurfaceFor } from './views/kit'

// The state this file reads and writes; the scan lists atoms per file.
const snapshot = atom({ plugin: 'gitlane', key: 'snapshot' } as const, null)
const view = atom({ plugin: 'gitlane', key: 'view' } as const, 'graph')

const PANE = 'git'
const POLL_MS = 30_000
// Kept across sessions: false once the person closed the pane, true after /git.
const AUTO_OPEN = 'autoOpen'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'git',
      description: 'Opens the git pane: history, branches, commit and push',
    })
    await $.command.register({
      name: 'git-commit',
      description: 'Commits the changes with a message Claude suggests, without opening the pane',
    })
    await $.command.register({
      name: 'git-push',
      description: 'Pushes the current branch with all its commits, without opening the pane',
    })
    await $.command.register({
      name: 'git-discardall',
      description: 'Discards every uncommitted change (asks to run again to confirm)',
    })
    await refresh($)
    if ((await $.store.get(AUTO_OPEN)) !== false) {
      void $.ui.open({ id: PANE, title: 'Git' })
    }
    $.clock.every(POLL_MS, () => void refresh($).catch(() => undefined))

    return started
  })

  on('command.run', { command: 'git' }, async $ => {
    await $.store.set(AUTO_OPEN, true)
    await refresh($)
    const opened = await $.ui.open({ id: PANE, title: 'Git' })

    return { text: opened.isPlaced ? 'Git pane opened.' : 'The git pane opens once there is room on screen.' }
  })

  // One step, no pane: Claude writes the message for every change and commits.
  on('command.run', { command: 'git-commit' }, async $ => {
    await refresh($)
    const outcome = await suggestAndCommit($)
    if (outcome === null) {
      return { text: 'Another git action is still running.' }
    }

    return { text: outcome.isOk ? outcome.value || 'Committed.' : outcome.error }
  })

  // Pushes the branch (all its unpushed commits) without opening the pane.
  on('command.run', { command: 'git-push' }, async $ => {
    await refresh($)
    const outcome = await push($)
    if (outcome === null) {
      return { text: 'Another git action is still running.' }
    }

    return { text: outcome.isOk ? outcome.value || 'Pushed.' : outcome.error }
  })

  // Throws away all uncommitted work; the first run asks, the second does it.
  on('command.run', { command: 'git-discardall' }, async $ => {
    const outcome = await discardAll($)
    if (outcome === null) {
      return { text: 'Another git action is still running.' }
    }

    return { text: outcome.isOk ? outcome.value || 'Discarded.' : outcome.error }
  })

  // Closed by hand, the pane stays closed in later sessions until /git.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      await $.store.set(AUTO_OPEN, false)
    }

    return next(e)
  })

  // Tools change files; the pane follows once a burst of calls settles.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    refreshSoon($)

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await refresh($).catch(() => undefined)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const kit: Kit = {
      Box: table.Box,
      Text: table.Text,
      Button: table.Button,
      Svg: 'Svg' in table ? table.Svg : undefined,
      Input: 'Input' in table ? table.Input : undefined,
      Select: 'Select' in table ? table.Select : undefined,
      openSurface: openSurfaceFor(e.surface),
      hoverSurface: hoverSurfaceFor(e.surface),
    }
    const { Box, Text, Button } = kit
    const snap = await read($, snapshot)

    if (snap === null) {
      return (
        <Text size="footnote" dimColor>
          Reading the repository…
        </Text>
      )
    }

    if (snap.kind === 'no-binary') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text weight="semibold">Git was not found</Text>
          <Text size="footnote" dimColor>
            Install Git, then start a new session.
          </Text>
        </Box>
      )
    }

    if (snap.kind === 'error') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="error">{snap.message}</Text>
          <Box>
            <Button key="refresh" dimColor label="Try again" onPress={() => void refresh($)} />
          </Box>
        </Box>
      )
    }

    if (snap.kind === 'no-git') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text weight="semibold">This folder is not a git repository</Text>
          <Text size="footnote" dimColor wrap="truncate-start">
            {snap.cwd}
          </Text>
          <Box gap={1}>
            <Button key="init" variant="primary" label="Create repository" onPress={() => void init($)} />
            <Button key="refresh" dimColor label="Refresh" onPress={() => void refresh($)} />
          </Box>
        </Box>
      )
    }

    const now = await $.clock.now()
    const tab = await read($, view)
    const header = await renderHeader($, kit, snap, now)
    const content =
      tab === 'graph'
        ? await renderGraph($, kit, snap, now)
        : tab === 'branches'
          ? await renderBranches($, kit, snap, now)
          : await renderChanges($, kit, snap, e.props.bodyColumns)

    // Tabs are text, not buttons: the open one in ink and weight, the rest muted,
    // so the pane's one filled control stays the action that matters (Push).
    const tabs: { key: View; label: string; count?: number }[] = [
      { key: 'graph', label: 'History' },
      { key: 'changes', label: 'Changes', count: snap.files.length },
      { key: 'branches', label: 'Branches' },
    ]

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Box justifyContent="space-between" alignItems="center" marginTop={1}>
          <Box gap={2}>
            {tabs.map(item => (
              <Button
                key={`tab-${item.key}`}
                plain
                dimColor={tab !== item.key}
                onPress={() => void update($, view, () => item.key)}
              >
                <Text weight={tab === item.key ? 'semibold' : 'regular'}>{item.label}</Text>
                {item.count ? <Text dimColor> {item.count}</Text> : ''}
              </Button>
            ))}
          </Box>
          {tab === 'graph' && snap.remotes.length > 0 && renderLegend(kit)}
        </Box>
        {content}
      </Box>
    )
  })
}
