import type {
  TextTurnResponse,
  MetricsResponse,
  SessionResponse,
  TracesResponse,
} from '../types/api'

const BASE = ''  // Vite proxy forwards /agent, /debug, /health to localhost:4010

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`HTTP ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

export async function sendTextTurn(
  message: string,
  sessionId?: string,
): Promise<TextTurnResponse> {
  const body: Record<string, string> = { message }
  if (sessionId) body.sessionId = sessionId
  return apiFetch<TextTurnResponse>(`${BASE}/agent/successvan/text-turn`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function fetchMetrics(): Promise<MetricsResponse> {
  return apiFetch<MetricsResponse>(`${BASE}/debug/metrics`)
}

export async function fetchSession(sessionId: string): Promise<SessionResponse> {
  return apiFetch<SessionResponse>(`${BASE}/debug/session/${encodeURIComponent(sessionId)}`)
}

export async function fetchTraces(): Promise<TracesResponse> {
  return apiFetch<TracesResponse>(`${BASE}/debug/traces`)
}

export async function fetchHealth(): Promise<{ status: string }> {
  return apiFetch<{ status: string }>(`${BASE}/health`)
}
