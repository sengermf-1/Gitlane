import type { GraphCommit, GraphRef } from '../types'
import { printable } from './git'
import { PHOSPHOR } from './phosphor'
import type { PhosphorName } from './phosphor'

/** `git log` format: hash, parents, decorations, subject, author, time. */
export const GRAPH_FORMAT = ['%H', '%P', '%D', '%s', '%an', '%ct'].join('%x1f') + '%x1e'

function parseRefs(decorations: string): GraphRef[] {
  const refs: GraphRef[] = []
  for (const raw of decorations.split(', ').filter(Boolean)) {
    const isHead = raw.startsWith('HEAD -> ')
    const name = isHead ? raw.slice('HEAD -> '.length) : raw
    if (name.startsWith('refs/heads/')) {
      refs.push({ kind: 'local', name: name.slice('refs/heads/'.length), isHead })
    } else if (name.startsWith('refs/remotes/')) {
      const short = name.slice('refs/remotes/'.length)
      // origin/HEAD only points at the remote's default branch.
      if (!short.endsWith('/HEAD')) {
        refs.push({ kind: 'remote', name: short, isHead: false })
      }
    } else if (name.startsWith('tag: refs/tags/')) {
      refs.push({ kind: 'tag', name: name.slice('tag: refs/tags/'.length), isHead: false })
    } else if (name === 'HEAD') {
      refs.push({ kind: 'detached', name: 'HEAD', isHead: true })
    }
  }

  // The checked-out branch first, then local, remote, tags.
  const order = { detached: 0, local: 1, remote: 2, tag: 3 } as const

  return refs.sort((a, b) => Number(b.isHead) - Number(a.isHead) || order[a.kind] - order[b.kind])
}

/** Parses `git log --decorate=full --format=GRAPH_FORMAT`. */
export function parseGraphLog(stdout: string): GraphCommit[] {
  return stdout
    .split('\x1e')
    .map(record => record.replace(/^\r?\n/, ''))
    .filter(Boolean)
    .map(record => {
      const [hash = '', parents = '', decorations = '', subject = '', author = '', seconds = '0'] =
        record.split('\x1f')

      return {
        hash,
        parents: parents.split(' ').filter(Boolean),
        refs: parseRefs(decorations),
        subject: printable(subject),
        author: printable(author),
        time: Number(seconds) * 1000,
      }
    })
}

export type Edge = { from: number; to: number; color: number }

export type GraphRow = {
  commit: GraphCommit
  lane: number
  color: number
  /** Lines from this row's center down to the next row's. */
  edges: Edge[]
}

export type GraphLayout = { rows: GraphRow[]; lanes: number }

/** The first free lane, from `from` on, other than `skip`. */
function freeLane(lanes: (string | null)[], skip: number, from: number): number {
  for (let i = from; i < lanes.length; i++) {
    if (lanes[i] === null && i !== skip) {
      return i
    }
  }

  return Math.max(lanes.length, from)
}

/** Sets a lane, filling any lanes before it with null so none is a hole. */
function setLane(lanes: (string | null)[], at: number, hash: string | null): void {
  while (lanes.length < at) {
    lanes.push(null)
  }
  lanes[at] = hash
}

/**
 * The commit the trunk runs down from: the local main or master, else the
 * remote's, else HEAD. Undefined when none of them is loaded.
 */
export function trunkTipOf(commits: readonly GraphCommit[]): string | undefined {
  const find = (test: (ref: GraphRef) => boolean) => commits.find(commit => commit.refs.some(test))?.hash

  return (
    find(ref => ref.kind === 'local' && ref.name === 'main') ??
    find(ref => ref.kind === 'local' && ref.name === 'master') ??
    find(ref => ref.kind === 'remote' && /\/(main|master)$/.test(ref.name)) ??
    find(ref => ref.isHead)
  )
}

/**
 * Lays commits (topological order, newest first) on lanes: each lane waits
 * for the hash of the next commit drawn in it.
 *
 * Given a trunk tip, its first-parent chain owns lane 0 in one colour, from
 * the tip down; every other commit takes a lane of its own. So a branch reads
 * as a branch even when history is linear: a commit made on `feature` on top
 * of `main` sits beside the trunk and joins it where it left.
 */
export function layoutGraph(commits: readonly GraphCommit[], trunkTip?: string): GraphLayout {
  const byHash = new Map(commits.map(commit => [commit.hash, commit]))
  const trunk = new Set<string>()
  for (let at = trunkTip ? byHash.get(trunkTip) : undefined; at && !trunk.has(at.hash); ) {
    trunk.add(at.hash)
    at = byHash.get(at.parents[0] ?? '')
  }
  // With a trunk, lane 0 is held for it: nothing else starts there.
  const first = trunk.size > 0 ? 1 : 0

  const lanes: (string | null)[] = first ? [null] : []
  const colors: number[] = first ? [0] : []
  let nextColor = first
  let width = 0
  const placed: {
    lane: number
    color: number
    after: (string | null)[]
    afterColors: number[]
    spawned: Edge[]
    opened: number[]
  }[] = []

  for (const commit of commits) {
    let lane: number
    if (trunk.has(commit.hash)) {
      lane = 0
    } else {
      lane = lanes.indexOf(commit.hash)
      if (lane < 0) {
        lane = freeLane(lanes, -1, first)
        colors[lane] = nextColor++
      }
    }
    const color = colors[lane] ?? 0

    // Every other lane that waited for this commit ends here.
    lanes.forEach((hash, i) => {
      if (hash === commit.hash && i !== lane) {
        lanes[i] = null
      }
    })

    setLane(lanes, lane, commit.parents[0] ?? null)
    const spawned: Edge[] = []
    const opened: number[] = []
    for (const parent of commit.parents.slice(1)) {
      let target = lanes.indexOf(parent)
      if (target < 0) {
        target = freeLane(lanes, lane, first)
        setLane(lanes, target, parent)
        colors[target] = nextColor++
        opened.push(target)
      }
      spawned.push({ from: lane, to: target, color: colors[target] ?? 0 })
    }

    // Trailing free lanes go, lane 0 stays held while there is a trunk.
    while (lanes.length > first && lanes[lanes.length - 1] === null) {
      lanes.pop()
    }
    width = Math.max(width, lanes.length, lane + 1)
    placed.push({ lane, color, after: [...lanes], afterColors: [...colors], spawned, opened })
  }

  const rows = commits.map((commit, i): GraphRow => {
    const here = placed[i]!
    const next = commits[i + 1]
    const nextLane = placed[i + 1]?.lane
    const edges: Edge[] = [...here.spawned.filter(edge => edge.from !== edge.to)]

    here.after.forEach((hash, k) => {
      if (hash === null) {
        return
      }
      const color = here.afterColors[k] ?? 0
      const isNext = next !== undefined && hash === next.hash && nextLane !== undefined
      // A lane this commit opened starts at its dot: the spawned edge draws it.
      if (here.opened.includes(k)) {
        return
      }
      edges.push({ from: k, to: isNext ? nextLane : k, color })
    })

    return { commit, lane: here.lane, color: here.color, edges }
  })

  return { rows, lanes: Math.max(1, width) }
}

export const PALETTE = [
  '#2ea3c0',
  '#e8833a',
  '#8cc152',
  '#c58bc0',
  '#e5534b',
  '#e6b84c',
  '#5b8def',
  '#4fbf9f',
  '#d9709b',
  '#9a85e6',
]

/** Where a commit lives: on a remote branch already, only here, or no remote at all. */
export type Sync = 'remote' | 'local' | null

/** The rail's colours: read on a light and a dark surface alike. */
export const SYNC_COLOR = { remote: '#3fb950', local: '#d29922' } as const
const MUTED = '#8b929c'

/** One row's height in CSS pixels; strips of adjacent rows meet edge to edge. */
export const ROW = 28
const MID = ROW / 2
const LANE = 16
// The sync rail, then the lanes.
const RAIL = 3
const GUTTER = 7
const PAD = 8
const DOT = 4.5
const RING = 4
const HEAD_RING = 7

export function colorOf(index: number): string {
  return PALETTE[index % PALETTE.length]!
}

export function stripWidth(lanes: number): number {
  return GUTTER + PAD * 2 + (lanes - 1) * LANE
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
}

const x = (lane: number) => GUTTER + PAD + lane * LANE

const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'

/**
 * The pane's motion: `reveal` draws an opened commit's lanes down. Nothing
 * animates on arrival: a tab switch remounts every image, so an entrance would
 * replay on each one and read as a blink. `in` and `pop` are kept as no-ops.
 */
export const MOTION =
  '<style>' +
  `.reveal{animation:reveal 300ms ${EASE} both}@keyframes reveal{from{height:0}to{height:720px}}` +
  '@media (prefers-reduced-motion:reduce){.reveal{animation:none}}' +
  '</style>'

function svg(width: number, height: number, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `${body}</svg>`
  )
}

function segment(from: number, y1: number, to: number, y2: number, color: string, dash = ''): string {
  const x1 = x(from)
  const x2 = x(to)
  const bend = (y2 - y1) * 0.65
  const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`

  return `<path d="${d}" stroke="${color}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
}

function rail(sync: Sync, top: number, bottom: number): string {
  return sync ? `<rect x="0" y="${top}" width="${RAIL}" height="${bottom - top}" fill="${SYNC_COLOR[sync]}"/>` : ''
}

export type StripOptions = {
  /** Where this commit lives, and the one above it: the rail breaks between runs. */
  sync: Sync
  syncAbove: Sync
  /** The working tree's row sits above this one, joined to it by a dashed line. */
  hasWorkingAbove: boolean
}

/**
 * The lanes of one row as its own SVG strip. An edge between two rows bends
 * in the half next to the commit it leaves (a branch opening) or reaches (a
 * lane joining), and runs straight through the other half; lines stop at a
 * hollow dot's ring rather than crossing it.
 */
export function renderLaneStrip(layout: GraphLayout, index: number, options: StripOptions): string {
  const row = layout.rows[index]!
  const above = layout.rows[index - 1]
  const isHead = row.commit.refs.some(ref => ref.isHead)
  const isLocal = options.sync === 'local'
  const trim = isHead ? HEAD_RING : isLocal ? RING : 0
  const paths: string[] = []

  for (const edge of above?.edges ?? []) {
    const color = colorOf(edge.color)
    const isJoin = edge.from !== edge.to && edge.from !== above!.lane
    const end = edge.to === row.lane ? MID - trim : MID
    paths.push(isJoin ? segment(edge.from, 0, edge.to, end, color) : segment(edge.to, 0, edge.to, end, color))
  }
  if (options.hasWorkingAbove) {
    paths.push(segment(row.lane, 0, row.lane, MID - trim, MUTED, '2 3'))
  }
  for (const edge of row.edges) {
    const color = colorOf(edge.color)
    const isOpen = edge.from !== edge.to && edge.from === row.lane
    const start = edge.from === row.lane ? MID + trim : MID
    paths.push(isOpen ? segment(edge.from, start, edge.to, ROW, color) : segment(edge.from, start, edge.from, ROW, color))
  }

  const color = colorOf(row.color)
  const cx = x(row.lane)
  const dot = isHead
    ? `<circle cx="${cx}" cy="${MID}" r="${HEAD_RING - 1}" fill="none" stroke="${color}" stroke-width="2"/>` +
      `<circle cx="${cx}" cy="${MID}" r="3" fill="${color}"/>`
    : isLocal
      ? `<circle cx="${cx}" cy="${MID}" r="${RING - 1}" fill="none" stroke="${color}" stroke-width="2"/>`
      : `<circle cx="${cx}" cy="${MID}" r="${DOT}" fill="${color}"/>`
  // A run of one kind reads as one bar; a change of kind leaves a hairline gap.
  const top = options.syncAbove !== null && options.syncAbove !== options.sync ? 2 : 0

  return svg(
    stripWidth(layout.lanes),
    ROW,
    MOTION + `<g class="in">${rail(options.sync, top, ROW)}<g fill="none" stroke-width="2" stroke-linecap="round">${paths.join('')}</g>${dot}</g>`,
  )
}

/** The uncommitted work as a row of its own above HEAD: a dashed ring on HEAD's lane. */
export function renderWorkingStrip(layout: GraphLayout, lane: number): string {
  const cx = x(lane)

  return svg(
    stripWidth(layout.lanes),
    ROW,
    `<circle cx="${cx}" cy="${MID}" r="${RING - 1}" fill="none" stroke="${MUTED}" stroke-width="2" stroke-dasharray="2 2.2"/>` +
      `<g fill="none" stroke-width="2" stroke-linecap="round">${segment(lane, MID + RING, lane, ROW, MUTED, '2 3')}</g>`,
  )
}

/**
 * What runs on under an open row: its rail and every lane leaving it, from
 * the strip's foot down `height` pixels. Drawn over the row from its top,
 * so its first ROW pixels stay empty for the strip itself.
 */
export function renderLaneExtension(layout: GraphLayout, index: number, sync: Sync, height: number): string {
  const row = layout.rows[index]!
  const paths = row.edges.map(edge => {
    const isOpen = edge.from !== edge.to && edge.from === row.lane
    const at = x(isOpen ? edge.to : edge.from)

    return `<path d="M${at} ${ROW}V${height}" stroke="${colorOf(edge.color)}"/>`
  })

  const width = stripWidth(layout.lanes)

  return svg(
    width,
    height,
    MOTION +
      `<defs><clipPath id="r"><rect class="reveal" x="0" y="0" width="${width}" height="${height}"/></clipPath></defs>` +
      `<g clip-path="url(#r)">${rail(sync, ROW, height)}<g fill="none" stroke-width="2">${paths.join('')}</g></g>`,
  )
}

/** Each kind of ref and the icon its badge carries. */
const REF_ICON: Record<GraphRef['kind'], PhosphorName> = {
  local: 'branch',
  detached: 'commit',
  remote: 'globe',
  tag: 'tag',
}

/** A Phosphor icon placed at (x, y), `size` pixels square, in `color`. */
function glyph(name: PhosphorName, x: number, y: number, size: number, color: string): string {
  const paths = PHOSPHOR[name].map(d => `<path d="${d}"/>`).join('')

  return `<g transform="translate(${x} ${y}) scale(${size / 256})" fill="${color}">${paths}</g>`
}

const BADGE_CHAR = 6.3
const BADGE_GAP = 6

export type Badge = { source: string; width: number }

/**
 * One ref as a badge. A branch is outlined in its lane's colour (dashed for
 * a remote one, a check on the one checked out); a tag is quiet: muted text
 * and icon, no outline, so a row of releases does not read as a row of chips.
 */
export function renderBadge(ref: GraphRef, colorIndex: number): Badge {
  const label = ref.name.length > 28 ? `${ref.name.slice(0, 27)}…` : ref.name
  const font = `style="font:600 11px system-ui,-apple-system,'Segoe UI',sans-serif"`

  if (ref.kind === 'tag') {
    const width = Math.round(18 + label.length * BADGE_CHAR) + BADGE_GAP

    return {
      width,
      source: svg(
        width,
        ROW,
        MOTION +
        `<g class="in">` +
        glyph('tag', 1, 8, 12, MUTED) +
          `<text x="16" y="18" fill="${MUTED}" ${font}>${escape(label)}</text></g>`,
      ),
    }
  }

  const color = colorOf(colorIndex)
  const check = ref.isHead ? 14 : 0
  const box = Math.round(24 + check + label.length * BADGE_CHAR)
  const width = box + BADGE_GAP
  const dash = ref.kind === 'remote' ? ' stroke-dasharray="3 2"' : ''

  return {
    width,
    source: svg(
      width,
      ROW,
      MOTION +
      `<g class="in" transform="translate(0.5 4.5)">` +
        `<rect width="${box - 1}" height="19" rx="4" fill="${color}" fill-opacity="0.14" stroke="${color}"${dash}/>` +
        (check ? glyph('current', 4, 3.5, 12, color) : '') +
        glyph(REF_ICON[ref.kind], 5 + check, 3.5, 12, color) +
        `<text x="${20 + check}" y="13.5" fill="${color}" ${font}>${escape(label)}</text>` +
        `</g>`,
    ),
  }
}

/** A swatch of the sync rail for the legend. */
export function renderRailSwatch(sync: Exclude<Sync, null>): string {
  return svg(RAIL + 1, 14, `<rect x="0" y="1" width="${RAIL}" height="12" fill="${SYNC_COLOR[sync]}"/>`)
}

/** A transparent 1px-wide strip: gives a line the height of a graph row. */
export const ROW_SPACER = svg(1, ROW, '')

export type IconName = PhosphorName
export const ICON_COLOR = { muted: MUTED, current: SYNC_COLOR.remote, accent: '#5b8def' } as const

/**
 * One Phosphor icon, `size` pixels square. `spin` turns it once every 0.9s:
 * SVG's own animation, the one motion the pane can draw, kept for work in
 * progress.
 */
export function renderIcon(name: IconName, color: string, size = 16, spin = false): string {
  const paths = PHOSPHOR[name].map(d => `<path d="${d}"/>`).join('')
  const turn = spin
    ? '<animateTransform attributeName="transform" type="rotate" from="0 128 128" to="360 128 128" dur="0.9s" repeatCount="indefinite"/>'
    : ''
  const motion = name === 'checkboxOn' ? 'pop' : 'in'

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">` +
    `${MOTION}<g class="${motion}"><g fill="${color}">${paths}${turn}</g></g></svg>`
  )
}

/** Each kind of change and its icon and colour in the Changes list. */
export const FILE_ICON = {
  modified: { icon: 'fileModified', color: '#d29922' },
  added: { icon: 'fileAdded', color: '#3fb950' },
  deleted: { icon: 'fileDeleted', color: '#e5534b' },
  renamed: { icon: 'fileRenamed', color: '#5b8def' },
  untracked: { icon: 'fileUntracked', color: '#3fb950' },
  conflict: { icon: 'conflict', color: '#e5534b' },
} as const satisfies Record<string, { icon: IconName; color: string }>
