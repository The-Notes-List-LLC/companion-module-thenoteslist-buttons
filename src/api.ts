/**
 * Thin client for /api/stations/* (see docs/BUTTON_STATIONS.md in the app repo).
 * Every response is JSON; errors carry { error, message }.
 */
/** A refused or failed request. status 0 = no HTTP answer at all (timeout, DNS, refused, offline). */
export class ApiError extends Error {
  constructor(readonly status: number, readonly error: string, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

type ModuleKey = 'cue' | 'work' | 'production' | 'electrician'
type Choice = { value: string; label: string; color?: string }

export type PairStart = { code: string; pollSecret: string; expiresAt: string }
export type PairPoll = { status?: 'pending'; token?: string; station?: { id: string; name: string; productionId: string; productionName: string | null } }
export type Me = {
  station: { id: string; name: string }
  production: { id: string; name: string | null }
  modules: Record<ModuleKey, boolean>
  options?: Record<ModuleKey, { priorities: Choice[]; types: Choice[] }>
}
export type Counts = Record<ModuleKey, { todo: number; review: number; outstanding: number }> & { asOf: string }
export type CreatedNote = { note: { id: string; status: string; priority: string; type: string | null }; coerced: Record<string, string | null>; replayed: boolean }
export type UiCommand = { command: string; module: string; status?: string; cueNumber?: string; type?: string; priority?: string }

/** Every request gives up after this long; Node's fetch otherwise waits indefinitely. */
const TIMEOUT_MS = 8000

export class StationApi {
  constructor(private baseUrl: string, private token: string | null) {}

  setToken(token: string | null): void { this.token = token }

  private async call<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) }
    if (auth) {
      if (!this.token) throw new ApiError(401, 'unauthorized', 'Not paired')
      headers.authorization = `Bearer ${this.token}`
    }
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`
    let res: Response
    try {
      res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (e) {
      throw new ApiError(0, 'network', networkMessage(e, url))
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      throw new ApiError(res.status, text(body.error) ?? 'error', text(body.message) ?? res.statusText)
    }
    return body as T
  }

  async pairStart(): Promise<PairStart> { return this.call('/api/stations/pair/start', { method: 'POST' }, false) }
  async pairPoll(code: string, pollSecret: string): Promise<PairPoll> {
    return this.call('/api/stations/pair/poll', { method: 'POST', body: JSON.stringify({ code, pollSecret }) }, false)
  }
  async me(): Promise<Me> { return this.call('/api/stations/me') }
  async counts(): Promise<Counts> { return this.call('/api/stations/counts') }
  async createNote(body: { module: string; description: string; priority?: string; type?: string; id: string; cueNumber?: string }): Promise<CreatedNote> {
    return this.call('/api/stations/notes', { method: 'POST', body: JSON.stringify(body) })
  }
  async openNoteEditor(module: string, cueNumber?: string): Promise<{ sent: boolean }> { return this.ui({ command: 'open_note_editor', module, cueNumber }) }
  async ui(body: UiCommand): Promise<{ sent: boolean }> {
    return this.call('/api/stations/ui', { method: 'POST', body: JSON.stringify(body) })
  }
  async revokeSelf(): Promise<{ revoked: boolean }> { return this.call('/api/stations/me', { method: 'DELETE' }) }
  async setLastStatus(status: string): Promise<{ note: { id: string; status: string } }> {
    return this.call('/api/stations/notes/last/status', { method: 'POST', body: JSON.stringify({ status }) })
  }
}

/** A JSON field as text, or undefined when it is missing or not a plain value. */
function text(v: unknown): string | undefined {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined
}

/** "fetch failed" says nothing; name the host and the real cause (ENOTFOUND, ECONNREFUSED, timeout…). */
function networkMessage(e: unknown, url: string): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  let host = url
  try { host = new URL(url).host } catch { /* keep the raw url */ }
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `No answer from ${host} within ${TIMEOUT_MS / 1000} s`
  const cause = err?.cause?.code ?? err?.cause?.message
  return cause ? `Cannot reach ${host} (${cause})` : `Cannot reach ${host} (${err?.message ?? String(e)})`
}
