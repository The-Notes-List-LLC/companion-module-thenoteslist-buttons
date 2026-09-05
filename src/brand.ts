/**
 * Brand bits for key faces. The N mark is the white script "N" from the app,
 * scaled to 26 px with a transparent background; Companion places it with
 * `pngalignment` so it sits in a corner while the text uses the rest.
 */
import { combineRgb } from '@companion-module/base'

export const N_PNG64 = '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'

/** Module colours as the app renders them in dark mode. */
export const MODULE_COLORS: Record<'cue' | 'work' | 'production' | 'electrician', string> = {
  cue: '#8b5cf6',
  work: '#3b82f6',
  production: '#06b6d4',
  electrician: '#22c55e',
}

/** Background = a hex colour; text white or black by luminance so it stays readable. */
export function keyStyle(hex: string): { bgcolor: number; color: number } {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16), g = parseInt(full.slice(2, 4), 16), b = parseInt(full.slice(4, 6), 16)
  if ([r, g, b].some((n) => Number.isNaN(n))) return { bgcolor: combineRgb(40, 40, 40), color: combineRgb(255, 255, 255) }
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return { bgcolor: combineRgb(r, g, b), color: luminance > 0.6 ? combineRgb(0, 0, 0) : combineRgb(255, 255, 255) }
}

/** The house key look: N in the top-left, text right-aligned, no Companion top bar. */
export function brandedStyle(text: string, hex: string, size: 'auto' | 14 | 18 | 24 = 'auto') {
  return {
    text,
    size,
    ...keyStyle(hex),
    alignment: 'right:center' as const,
    png64: N_PNG64,
    pngalignment: 'left:top' as const,
    show_topbar: false,
  }
}
