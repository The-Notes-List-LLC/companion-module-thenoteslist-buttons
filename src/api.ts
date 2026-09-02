/**
 * Thin client for /api/stations/* (see docs/BUTTON_STATIONS.md in the app repo).
 * Every response is JSON; errors carry { error, message }.
 */
export interface ApiError { status: number; error: string; message: string }

export class StationApi {
  constructor(private baseUrl: string, private token: string | null) {}

  setToken(token: string | null): void { this.token = token }

  private async call<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) }
    if (auth) {
      if (!this.token) throw <ApiError>{ status: 401, error: 'unauthorized', message: 'Not paired' }
      headers.authorization = `Bearer ${this.token}`
    }
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, { ...init, headers })
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
    return this.call<{ station: { id: string; name: string }; production: { id: string; name: string | null }; modules: Record<'cue' | 'work' | 'production' | 'electrician', boolean> }>('/api/stations/me')
  }
  counts() {
    return this.call<Record<'cue' | 'work' | 'production' | 'electrician', { todo: number; review: number; outstanding: number }> & { asOf: string }>('/api/stations/counts')
  }
  createNote(body: { module: string; description: string; priority?: string; type?: string; id: string }) {
    return this.call<{ note: { id: string; status: string; priority: string; type: string | null }; coerced: Record<string, string | null>; replayed: boolean }>(
      '/api/stations/notes', { method: 'POST', body: JSON.stringify(body) })
  }
  revokeSelf() { return this.call<{ revoked: boolean }>('/api/stations/me', { method: 'DELETE' }) }
  setLastStatus(status: string) {
    return this.call<{ note: { id: string; status: string } }>('/api/stations/notes/last/status', { method: 'POST', body: JSON.stringify({ status }) })
  }
}
