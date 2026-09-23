/**
 * Thin client for /api/stations/* (see docs/BUTTON_STATIONS.md in the app repo).
 * Every response is JSON; errors carry { error, message }.
 */
/** status 0 = no HTTP answer at all (timeout, DNS, refused, offline). */
export interface ApiError { status: number; error: string; message: string }

/** Every request gives up after this long; Node's fetch otherwise waits indefinitely. */
const TIMEOUT_MS = 8000

export class StationApi {
  constructor(private baseUrl: string, private token: string | null) {}

  setToken(token: string | null): void { this.token = token }

  private async call<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) }
    if (auth) {
      if (!this.token) throw <ApiError>{ status: 401, error: 'unauthorized', message: 'Not paired' }
      headers.authorization = `Bearer ${this.token}`
    }
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`
    let res: Response
    try {
      res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (e) {
      throw <ApiError>{ status: 0, error: 'network', message: networkMessage(e, url) }
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      throw <ApiError>{ status: res.status, error: String(body.error ?? 'error'), message: String(body.message ?? res.statusText) }
    }
    return body as T
  }

  pairStart() { return this.call<{ code: string; pollSecret: string; expiresAt: string }>('/api/stations/pair/start', { method: 'POST' }, false) }
  pairPoll(code: string, pollSecret: string) {
    return this.call<{ status?: 'pending'; token?: string; station?: { id: string; name: string; productionId: string; productionName: string | null } }>(
      '/api/stations/pair/poll', { method: 'POST', body: JSON.stringify({ code, pollSecret }) }, false)
  }
  me() {
    return this.call<{
      station: { id: string; name: string }
      production: { id: string; name: string | null }
      modules: Record<'cue' | 'work' | 'production' | 'electrician', boolean>
      options?: Record<'cue' | 'work' | 'production' | 'electrician', { priorities: Array<{ value: string; label: string; color?: string }>; types: Array<{ value: string; label: string; color?: string }> }>
    }>('/api/stations/me')
  }
  counts() {
    return this.call<Record<'cue' | 'work' | 'production' | 'electrician', { todo: number; review: number; outstanding: number }> & { asOf: string }>('/api/stations/counts')
  }
  createNote(body: { module: string; description: string; priority?: string; type?: string; id: string; cueNumber?: string }) {
    return this.call<{ note: { id: string; status: string; priority: string; type: string | null }; coerced: Record<string, string | null>; replayed: boolean }>(
      '/api/stations/notes', { method: 'POST', body: JSON.stringify(body) })
  }
  openNoteEditor(module: string, cueNumber?: string) { return this.ui({ command: 'open_note_editor', module, cueNumber }) }
  ui(body: { command: string; module: string; status?: string; cueNumber?: string; type?: string; priority?: string }) {
    return this.call<{ sent: boolean }>('/api/stations/ui', { method: 'POST', body: JSON.stringify(body) })
  }
  revokeSelf() { return this.call<{ revoked: boolean }>('/api/stations/me', { method: 'DELETE' }) }
  setLastStatus(status: string) {
    return this.call<{ note: { id: string; status: string } }>('/api/stations/notes/last/status', { method: 'POST', body: JSON.stringify({ status }) })
  }
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
