/**
 * The selected-cue cursor (#907), kept apart from the desk connection so it can
 * be tested on its own.
 *
 * The cursor is a CUE NUMBER, never a sheet index: an insert or delete on the
 * desk (or a reconnect) re-reads the list and shifts every index after it, and
 * an index would then quietly point at a different cue. A number keeps its
 * meaning while the list is re-read.
 *
 * Parts occupy their own index in the sheet but are never a place a note lands,
 * so steps and offsets count base cues only.
 */
import type { EosCue } from './eos.js'

/** Read access to the desk's cue list as far as it is cached. */
export interface CueSheet {
  /** The cue record at a sheet index, if cached. */
  at(index: number): EosCue | undefined
  /** Sheet index of a base cue, if cached. */
  indexOf(number: string): number | undefined
  /** Records in the list (base cues plus parts); 0 until the desk answers. */
  readonly count: number
}

export type StepResult =
  | { ok: true; cue: EosCue }
  /** no-live: nothing to step from yet. not-cached: the start cue has no index yet. loading: a record on the way is not cached (fetch around `index`). */
  | { ok: false; reason: 'no-live' | 'not-cached' | 'loading'; index?: number }

export class CueCursor {
  /** The cue the operator stepped to; null = follow the live cue. */
  selected: string | null = null

  /** The cue a note lands on: the stepped cue, else the live cue. */
  target(live: string | null): string | null {
    return this.selected ?? live
  }

  reset(): void {
    this.selected = null
  }

  /**
   * Move `delta` base cues from the current target. Stops at either end of the
   * list; refuses (and moves nothing) when a record on the way is not cached,
   * rather than skipping over a cue it cannot see.
   */
  step(delta: number, sheet: CueSheet, live: string | null): StepResult {
    const from = this.target(live)
    if (from === null) return { ok: false, reason: 'no-live' }
    const start = sheet.indexOf(from)
    if (start === undefined) return { ok: false, reason: 'not-cached' }
    let cue = sheet.at(start) as EosCue
    const dir = Math.sign(delta)
    for (let n = 0; n < Math.abs(delta); n++) {
      const r = neighbour(sheet, cue.index, dir)
      if ('end' in r) break
      if ('missing' in r) return { ok: false, reason: 'loading', index: r.missing }
      cue = r.cue
    }
    // Landing back on the live cue means following it again.
    this.selected = cue.number === live ? null : cue.number
    return { ok: true, cue }
  }

  /** Base cues from live to the target (negative = earlier); null while that stretch is not cached. */
  offset(sheet: CueSheet, live: string | null): number | null {
    if (this.selected === null) return 0
    if (live === null) return null
    const a = sheet.indexOf(live)
    const b = sheet.indexOf(this.selected)
    if (a === undefined || b === undefined) return null
    const lo = Math.min(a, b), hi = Math.max(a, b)
    let n = 0
    for (let i = lo + 1; i <= hi; i++) {
      const c = sheet.at(i)
      if (!c) return null
      if (c.part === 0) n++
    }
    return b < a ? -n : n
  }

  /**
   * The desk fired another cue. By default the cursor returns to live; with
   * keepOffset it holds the same number of base cues from the new live cue,
   * measured against the OLD live cue before it moved.
   */
  liveMoved(oldLive: string | null, newLive: string, sheet: CueSheet, keepOffset: boolean): void {
    if (this.selected === null) return
    const steps = keepOffset ? this.offset(sheet, oldLive) : null
    this.selected = null
    if (steps) this.step(steps, sheet, newLive)
  }
}

/** The next base cue from sheet index `from` in direction `dir`, skipping parts. */
function neighbour(sheet: CueSheet, from: number, dir: number): { cue: EosCue } | { missing: number } | { end: true } {
  for (let i = from + dir; ; i += dir) {
    if (i < 0 || (sheet.count > 0 && i >= sheet.count)) return { end: true }
    const c = sheet.at(i)
    if (!c) return { missing: i }
    if (c.part === 0) return { cue: c }
  }
}
