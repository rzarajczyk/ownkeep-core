import { NOTE_COLORS } from '../utils'

/** Takeout color names → OwnKeep palette hex. */
const KEEP_COLOR_NAMES: Record<string, string> = {
  DEFAULT: '#ffffff',
  WHITE: '#ffffff',
  CHALK: '#ffffff',
  RED: '#f28b82',
  CORAL: '#f28b82',
  ORANGE: '#fbbc04',
  PEACH: '#fbbc04',
  YELLOW: '#fff475',
  SAND: '#fff475',
  GREEN: '#ccff90',
  SAGE: '#ccff90',
  MINT: '#ccff90',
  TEAL: '#a7ffeb',
  BLUE: '#cbf0f8',
  FOG: '#cbf0f8',
  CERULEAN: '#aecbfa',
  DARK_BLUE: '#aecbfa',
  PURPLE: '#d7aefb',
  DUSK: '#d7aefb',
  PINK: '#fdcfe8',
  BLOSSOM: '#fdcfe8',
  BROWN: '#e6c9a8',
  CLAY: '#e6c9a8',
  GRAY: '#e8eaed',
  GREY: '#e8eaed',
  STORM: '#e8eaed',
}

const NOTE_COLOR_VALUES = new Set<string>(NOTE_COLORS.map((color) => color.value))

export function mapKeepColor(raw: string | undefined): { color: string; unknown: boolean } {
  if (!raw) return { color: '#ffffff', unknown: false }
  const trimmed = raw.trim()
  if (!trimmed) return { color: '#ffffff', unknown: false }
  const asHex = trimmed.toLowerCase()
  if (NOTE_COLOR_VALUES.has(asHex)) return { color: asHex, unknown: false }
  const mapped = KEEP_COLOR_NAMES[trimmed.toUpperCase().replace(/-/g, '_')]
  if (mapped) return { color: mapped, unknown: false }
  return { color: '#ffffff', unknown: true }
}
