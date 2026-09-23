/**
 * Brand bits for key faces. N_PNG64 is a full 72×72 key image: transparent
 * except a 20 px white script "N" at top-left (Companion stretches any png64
 * to the key, so the image must already be key-sized).
 */
import { combineRgb } from '@companion-module/base'

export const N_PNG64 = 'iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAABLklEQVR42u3VvyvEcRzH8eOW25VFkjKQzWX0YzVYlJSFTCblFhksBmxksF0KpRRlOKUoRlaLP8Ag+bEZLF/PT97DuVGZPs9HPdP3c7fcq+/3q1SSJEmS9M+KouiiEZqmeZqjA5qMz8fpiBo0ldMwM3RLr3RPddoufqSBOmOw5JMe6YbacxhnMX74G01QOc634nyN+uiLzqgnDUMdudw9dzHEXtPZKH3QJW3GMOnOquT43jmJgZ7jMarQAx3TMp3SOw3n+mLupv14B83SRgw2SLV49Bq5jlNuuV6KcQ7jej2uF3Icpy0NQTu0SlcxxlO6q+I79Tir5jrQdfHbC401fec8zgdyfcR6aZcu4m9/y+dDtJLNv3RJkiRJkiRJkiRJkiRJkiRJkiRJkiTpD74By2Z6vXgbfSsAAAAASUVORK5CYII='

/** Same mark in black, for light backgrounds (amber feedback, pale chip colours). */
export const N_PNG64_DARK = 'iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAABKElEQVR42u3VvSuFYQCG8YPFriySlIFsZPSxGixKykImk2KRwWLARgabFEopykApipHV4g8wSD42g4Xr1K1OZzOYnutXV3qfYzl37/ueSkWSJEnS/2ujQZqgGZqmfRrL5yN0SOc0XtIwk3RLr3RPu7RJ3xmoNYNVrz/pkW6osYRx5vLF32iUmnK+kfMV6qIvOqWODNNSyt1zlyF2as6G6IMuaT3DVO+s5hLfO8cZ6DmPUXWEBzqiBTqhdxoo9cXcTnt5B03RWgbrpcU8eueljtNUdz2fcQ5yvZrr2RLHacgQW7RMVxnjKXdVJb9m1bP+Uge6zgC/vdBwzf+c5byn1Eesk7bpIn+76z7vo6WSftIlSZIkSZIkSZIkSZIkSZIkSZIkSZKkv/oBdcw673kXRusAAAAASUVORK5CYII='

/** Module colours as the app renders them in dark mode. */
export const MODULE_COLORS: Record<'cue' | 'work' | 'production' | 'electrician', string> = {
  cue: '#8b5cf6',
  work: '#3b82f6',
  production: '#06b6d4',
  electrician: '#22c55e',
}

/** Background = a hex colour; text white or black by luminance so it stays readable. */
export function keyStyle(hex: string): { bgcolor: number; color: number } {
  const { bgcolor, light } = parseBg(hex)
  return { bgcolor, color: light ? combineRgb(0, 0, 0) : combineRgb(255, 255, 255) }
}

function parseBg(hex: string): { bgcolor: number; light: boolean } {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const r = parseInt(full.slice(0, 2), 16), g = parseInt(full.slice(2, 4), 16), b = parseInt(full.slice(4, 6), 16)
  if ([r, g, b].some((n) => Number.isNaN(n))) return { bgcolor: combineRgb(40, 40, 40), light: false }
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return { bgcolor: combineRgb(r, g, b), light: luminance > 0.6 }
}

/** Mix a hex colour toward white by `amount` (0-1); for coloured text on dark keys. */
export function tint(hex: string, amount: number): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return '#' + [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16)
    return Math.round(v + (255 - v) * amount).toString(16).padStart(2, '0')
  }).join('')
}

/** Action colours: what the key DOES, which outranks the module colour. */
export const ACTION_COLORS = {
  done: '#16a34a',
  cancel: '#dc2626',
  review: '#475569',
  /** Navigation and neutral keys: next/prev, undo/redo, back to To Do, cue keys. */
  neutral: '#1f1f1f',
}

/**
 * The house key look: N in the top-left, text right-aligned on the BOTTOM edge
 * of every key so a row of keys shares one baseline, no Companion top bar.
 * Keep faces to two lines: at 18 px two bottom-aligned lines clear the N
 * whatever their width; 24 px only for words of three characters or fewer.
 * `textHex` overrides the text colour (dark nav keys carry the module colour
 * in their text so a NEXT for Work still reads as Work).
 */
export function brandedStyle(text: string, hex: string, size: 'auto' | 14 | 18 | 24 = 18, textHex?: string) {
  const base = keyStyle(hex)
  return {
    text,
    size,
    ...base,
    color: textHex ? keyStyle(textHex).bgcolor : base.color,
    alignment: 'right:bottom' as const,
    png64: parseBg(hex).light ? N_PNG64_DARK : N_PNG64,
    pngalignment: 'center:center' as const,
    show_topbar: false,
  }
}
