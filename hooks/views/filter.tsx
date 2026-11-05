import type { RenderElement } from 'claude-code'

import { highlight } from '../filter'
import { ICON_COLOR, renderIcon } from '../graph'
import type { Kit } from './kit'
import { iconElement } from './kit'

/**
 * A text with the query's terms in semibold ink: what made a row match, seen
 * at a glance. With no terms, the text as it was.
 */
export function marked(kit: Kit, text: string, terms: readonly string[]): RenderElement[] | string {
  const { Text } = kit
  if (terms.length === 0) {
    return text
  }

  return highlight(text, terms).map(segment =>
    segment.isMatch ? <Text weight="semibold">{segment.text}</Text> : <Text>{segment.text}</Text>,
  )
}

export type FilterFieldOptions = {
  key: string
  value: string
  placeholder: string
  onChange: (value: string) => void
}

/** The filter field of a tab: filters as you type; Clear empties it. */
export function renderFilterField(kit: Kit, options: FilterFieldOptions): RenderElement | false {
  const { Box, Button, Input } = kit
  if (!Input) {
    return false
  }

  return (
    <Box gap={1} alignItems="center">
      {iconElement(kit, renderIcon('search', ICON_COLOR.muted), 'filter')}
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Input
          key={options.key}
          placeholder={options.placeholder}
          value={options.value}
          submitLabel="Done"
          onInput={options.onChange}
          onSubmit={options.onChange}
        />
      </Box>
      {options.value !== '' && (
        <Button key={`${options.key}-clear`} plain dimColor label="Clear" onPress={() => options.onChange('')} />
      )}
    </Box>
  )
}
