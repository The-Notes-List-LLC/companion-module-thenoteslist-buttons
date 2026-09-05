/**
 * Brand bits for key faces. N_PNG64 is a full 72×72 key image: transparent
 * except a 20 px white script "N" at top-left (Companion stretches any png64
 * to the key, so the image must already be key-sized).
 */
import { combineRgb } from '@companion-module/base'

export const N_PNG64 = 'iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAABLklEQVR42u3VvyvEcRzH8eOW25VFkjKQzWX0YzVYlJSFTCblFhksBmxksF0KpRRlOKUoRlaLP8Ag+bEZLF/PT97DuVGZPs9HPdP3c7fcq+/3q1SSJEmS9M+KouiiEZqmeZqjA5qMz8fpiBo0ldMwM3RLr3RPddoufqSBOmOw5JMe6YbacxhnMX74G01QOc634nyN+uiLzqgnDUMdudw9dzHEXtPZKH3QJW3GMOnOquT43jmJgZ7jMarQAx3TMp3SOw3n+mLupv14B83SRgw2SLV49Bq5jlNuuV6KcQ7jej2uF3Icpy0NQTu0SlcxxlO6q+I79Tir5jrQdfHbC401fec8zgdyfcR6aZcu4m9/y+dDtJLNv3RJkiRJkiRJkiRJkiRJkiRJkiRJkiTpD74By2Z6vXgbfSsAAAAASUVORK5CYII='

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
  // 'auto' shrinks long words instead of wrapping them mid-word.
  return {
    text,
    size,
    ...keyStyle(hex),
    alignment: 'right:center' as const,
    png64: N_PNG64,
    pngalignment: 'center:center' as const,
    show_topbar: false,
  }
}
