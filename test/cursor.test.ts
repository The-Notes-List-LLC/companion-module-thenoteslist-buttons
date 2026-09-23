import { describe, expect, it } from 'vitest'
import { CueCursor, type CueSheet } from '../src/cursor.js'
import type { EosCue } from '../src/eos.js'

/**
 * A sheet from a compact spec: '10 20 20/1 30' = cue 10, cue 20, a part of 20,
 * cue 30, at indexes 0..3. `missing` leaves those indexes uncached.
 */
function sheet(spec: string, missing: number[] = []): CueSheet & { cues: EosCue[] } {
  const cues = spec.split(/\s+/).map((tok, index) => {
    const [number, part] = tok.split('/')
    return { number, label: `L${number}`, index, part: Number(part ?? 0) }
  })
  const cached = cues.filter((c) => !missing.includes(c.index))
  return {
    cues,
    count: cues.length,
    at: (i) => cached.find((c) => c.index === i),
    indexOf: (n) => cached.find((c) => c.number === n && c.part === 0)?.index,
  }
}

describe('CueCursor.step', () => {
  it('follows live until stepped, then holds a cue number', () => {
    const s = sheet('10 20 30 40')
    const c = new CueCursor()
    expect(c.target('20')).toBe('20')
    expect(c.step(1, s, '20')).toMatchObject({ ok: true, cue: { number: '30' } })
    expect(c.selected).toBe('30')
    expect(c.target('20')).toBe('30')
  })

  it('steps over parts in both directions', () => {
    const s = sheet('10 20 20/1 20/2 30')
    const c = new CueCursor()
    c.step(1, s, '20')
    expect(c.selected).toBe('30')
    c.step(-1, s, '20')
    expect(c.selected).toBeNull() // back on live = following live
    c.step(-1, s, '30')
    expect(c.selected).toBe('20')
  })

  it('stops at both ends of the list and never rests on a trailing part', () => {
    const s = sheet('10 20 20/1')
    const c = new CueCursor()
    c.step(5, s, '10')
    expect(c.selected).toBe('20')
    c.step(-9, s, '20')
    expect(c.selected).toBe('10')
  })

  it('refuses rather than skipping an uncached cue', () => {
    const s = sheet('10 20 30 40', [2])
    const c = new CueCursor()
    expect(c.step(2, s, '20')).toEqual({ ok: false, reason: 'loading', index: 2 })
    expect(c.selected).toBeNull()
  })

  it('reports no-live and not-cached', () => {
    const c = new CueCursor()
    expect(c.step(1, sheet('10 20'), null)).toMatchObject({ ok: false, reason: 'no-live' })
    expect(c.step(1, sheet('10 20', [1]), '20')).toMatchObject({ ok: false, reason: 'not-cached' })
  })
})

describe('CueCursor.offset', () => {
  it('counts base cues, not indexes', () => {
    const s = sheet('10 10/1 20 20/1 30')
    const c = new CueCursor()
    c.step(2, s, '10')
    expect(c.selected).toBe('30')
    expect(c.offset(s, '10')).toBe(2)
    c.step(-2, s, '10') // back to 10 = live
    c.step(-1, s, '20')
    expect(c.offset(s, '20')).toBe(-1)
  })

  it('is unknown while the stretch between live and the cursor is uncached', () => {
    const c = new CueCursor()
    c.step(2, sheet('10 20 30'), '10')
    expect(c.offset(sheet('10 20 30', [1]), '10')).toBeNull()
  })
})

describe('CueCursor.liveMoved', () => {
  it('returns to live by default', () => {
    const s = sheet('10 20 30 40')
    const c = new CueCursor()
    c.step(-1, s, '30')
    c.liveMoved('30', '40', s, false)
    expect(c.selected).toBeNull()
    expect(c.target('40')).toBe('40')
  })

  it('keeps the offset in base cues, measured before live moved', () => {
    const s = sheet('10 20 20/1 30 40 50')
    const c = new CueCursor()
    c.step(-1, s, '30') // one back from live: 20
    c.liveMoved('30', '40', s, true)
    expect(c.selected).toBe('30') // still one back, over the part
    c.liveMoved('40', '50', s, true)
    expect(c.selected).toBe('40')
  })

  it('does nothing while following live', () => {
    const c = new CueCursor()
    c.liveMoved('10', '20', sheet('10 20'), true)
    expect(c.selected).toBeNull()
  })
})

describe('an insert on the desk', () => {
  it('keeps the selected cue across a re-read that shifts every index', () => {
    const c = new CueCursor()
    c.step(1, sheet('10 20 30 40'), '20')
    expect(c.selected).toBe('30')
    // 15 inserted above: every later index moves by one. An index cursor (2)
    // would now point at 20; the cue number still means 30.
    const after = sheet('10 15 20 30 40')
    expect(c.target('20')).toBe('30')
    expect(c.offset(after, '20')).toBe(1)
    // Mid re-read (30 not cached yet) the target is still 30, never live.
    expect(c.target('20')).toBe('30')
    expect(c.offset(sheet('10 15 20 30 40', [3]), '20')).toBeNull()
  })
})
