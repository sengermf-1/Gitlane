import type {
  BoxProps,
  ButtonProps,
  ElementConstructor,
  InputProps,
  RenderElement,
  RenderSurface,
  SelectProps,
  SvgProps,
  TextProps,
} from 'claude-code'

/**
 * The elements a view draws with: the three every surface has, and the ones
 * only some do (the terminal draws no SVG, mobile no field).
 */
export type Kit = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Svg: ElementConstructor<SvgProps> | undefined
  Input: ElementConstructor<InputProps> | undefined
  Select: ElementConstructor<SelectProps> | undefined
  /** The one surface an open item sits on; none where the surface takes no CSS colour. */
  openSurface: { backgroundColor: string } | Record<string, never>
  /** A lighter tint under the pointer, for a keyed row Box's `hover`. */
  hoverSurface: { hover: { backgroundColor: string } } | Record<string, never>
}

const isGraphical = (surface: RenderSurface) => surface === 'desktop' || surface === 'vscode'

/** A neutral tint that reads on a light and a dark pane alike. */
export function openSurfaceFor(surface: RenderSurface): Kit['openSurface'] {
  return isGraphical(surface) ? { backgroundColor: 'rgba(127, 127, 127, 0.12)' } : {}
}

/** Half the open tint: a row under the pointer, so the whole row reads as one target. */
export function hoverSurfaceFor(surface: RenderSurface): Kit['hoverSurface'] {
  return isGraphical(surface) ? { hover: { backgroundColor: 'rgba(127, 127, 127, 0.07)' } } : {}
}

/** Says a count with its noun: "1 file", "3 files". */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** Draws an icon as an `Svg` element, or nothing on a surface without SVG. */
export function iconElement(kit: Kit, source: string, alt: string, size = 14): RenderElement | false {
  const { Svg, Box } = kit

  return Svg ? (
    <Box flexShrink={0}>
      <Svg source={source} alt={alt} width={size} height={size} />
    </Box>
  ) : (
    false
  )
}

/** Sets `item` on the open surface when `isOpen`: the plain tint, as it appears. */
export function surfaced(kit: Kit, isOpen: boolean, item: RenderElement): RenderElement {
  const { Box } = kit

  return isOpen ? <Box {...kit.openSurface}>{item}</Box> : item
}
