import type { BranchInfo, GraphCommit } from '../types'

/** A query as lower-case terms; every term has to match somewhere. */
export function termsOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

function hasTerm(term: string, fields: readonly string[]): boolean {
  return fields.some(field => field.toLowerCase().includes(term))
}

/** A commit matches when each term is in its subject, author or refs, or starts its hash. */
export function matchesCommit(commit: GraphCommit, terms: readonly string[]): boolean {
  const fields = [commit.subject, commit.author, ...commit.refs.map(ref => ref.name)]

  return terms.every(term => commit.hash.startsWith(term) || hasTerm(term, fields))
}

/** A branch matches when each term is in its name, its upstream or its last commit's subject. */
export function matchesBranch(branch: BranchInfo, terms: readonly string[]): boolean {
  const fields = [branch.name, branch.upstream ?? '', branch.subject]

  return terms.every(term => hasTerm(term, fields))
}

export type Segment = { text: string; isMatch: boolean }

/** Splits `text` into runs, marking where any term occurs (overlaps merged). */
export function highlight(text: string, terms: readonly string[]): Segment[] {
  const lower = text.toLowerCase()
  const marked = new Array<boolean>(text.length).fill(false)
  for (const term of terms) {
    for (let at = lower.indexOf(term); at >= 0 && term; at = lower.indexOf(term, at + 1)) {
      marked.fill(true, at, at + term.length)
    }
  }

  const segments: Segment[] = []
  for (let i = 0; i < text.length; i++) {
    const last = segments[segments.length - 1]
    if (last && last.isMatch === marked[i]) {
      last.text += text[i]
    } else {
      segments.push({ text: text[i]!, isMatch: marked[i]! })
    }
  }

  return segments
}
