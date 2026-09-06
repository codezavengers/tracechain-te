// Resilient HTTP layer for blockchain provider adapters.
//
// Responsibilities:
//   - Configurable request timeouts (AbortController)
//   - Retry with exponential backoff + jitter for RETRYABLE failures only
//   - Rate-limit awareness (HTTP 429 + Retry-After header) with a dedicated code
//   - Typed, human-readable errors so callers can decide to fall back to MOCK
//
// This module NEVER logs or exposes API keys. Callers build fully-formed URLs
// (with the key already appended from a server-side env var) and pass them in;
// any key-shaped query param is redacted before it can appear in an error.

// Canonical error taxonomy surfaced to callers and (safely) to the frontend.
export type ProviderErrorKind =
  | "timeout"
  | "rate_limited"
  | "not_configured"
  | "network"
  | "http"
  | "invalid_response"
  | "unsupported"

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly status?: number,
    // Milliseconds the upstream asked us to wait (from Retry-After), if any.
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = "ProviderError"
  }

  // Stable, machine-readable code for API responses (never leaks internals).
  get code(): string {
    return `provider_${this.kind}`
  }

  get retryable(): boolean {
    return isRetryableKind(this.kind, this.status)
  }
}

export interface FetchOptions {
  timeoutMs?: number
  // Number of RETRIES after the initial attempt (total attempts = retries + 1).
  retries?: number
  headers?: Record<string, string>
  method?: string
  body?: string
  // A label used only for error messages (never includes secrets).
  label?: string
}

// Phase 5: default request timeout.
export const DEFAULT_TIMEOUT_MS = 10_000
// Phase 3: configurable maximum retries (attempts = retries + 1).
export const DEFAULT_RETRIES = 3
// Backoff base — 500ms → 1s → 2s → ... (matches the documented ramp).
export const BACKOFF_BASE_MS = 500
export const MAX_BACKOFF_MS = 8_000

// Retryable HTTP statuses (transient). Everything else 4xx is terminal.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])
// Explicitly non-retryable client errors (documented for clarity).
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404])

export function isRetryableStatus(status: number): boolean {
  if (RETRYABLE_STATUS.has(status)) return true
  if (NON_RETRYABLE_STATUS.has(status)) return false
  // Any other 5xx is transient; any other 4xx is terminal.
  return status >= 500
}

function isRetryableKind(kind: ProviderErrorKind, status?: number): boolean {
  switch (kind) {
    case "timeout":
    case "rate_limited":
    case "network":
      return true
    case "http":
      return status ? isRetryableStatus(status) : false
    default:
      return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Exponential backoff with full jitter, capped.
export function backoffDelay(attempt: number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, MAX_BACKOFF_MS)
  const jitter = Math.floor(Math.random() * (base * 0.25))
  return base + jitter
}

// Redact anything that looks like a key/token from a URL before it ever
// appears in an error message.
export function safeUrl(url: string): string {
  try {
    const u = new URL(url)
    for (const secretParam of ["apikey", "apiKey", "api_key", "key", "token", "access_token"]) {
      if (u.searchParams.has(secretParam)) u.searchParams.set(secretParam, "***")
    }
    return `${u.origin}${u.pathname}`
  } catch {
    return "<url>"
  }
}

function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get("retry-after")
  if (!raw) return undefined
  // Retry-After may be seconds or an HTTP date.
  const secs = Number(raw)
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000
  const date = Date.parse(raw)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}

async function fetchWithTimeout(url: string, timeoutMs: number, opts: FetchOptions): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      method: opts.method ?? "GET",
      body: opts.body,
      headers: { accept: "application/json", ...opts.headers },
      signal: controller.signal,
      cache: "no-store",
    })
  } finally {
    clearTimeout(timer)
  }
}

// Core resilient JSON fetch. Throws a typed ProviderError on final failure.
// Never silently hides failures: after exhausting retries the last typed error
// is thrown so the service layer can record the reason and fall back honestly.
export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = opts.retries ?? DEFAULT_RETRIES
  const label = opts.label ?? safeUrl(url)

  let lastErr: ProviderError | null = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, timeoutMs, opts)

      // Phase 4 — rate limited. Respect Retry-After when present, else back off.
      if (res.status === 429) {
        const retryAfterMs = parseRetryAfter(res)
        lastErr = new ProviderError(`${label} rate-limited (429).`, "rate_limited", 429, retryAfterMs)
        if (attempt < retries) {
          await sleep(retryAfterMs ?? backoffDelay(attempt))
          continue
        }
        throw lastErr
      }

      if (!res.ok) {
        const retryable = isRetryableStatus(res.status)
        const err = new ProviderError(`${label} request failed (${res.status}).`, "http", res.status)
        if (retryable && attempt < retries) {
          lastErr = err
          await sleep(backoffDelay(attempt))
          continue
        }
        // Terminal 4xx (400/401/403/404/...) — do not retry, bubble up.
        throw err
      }

      try {
        return (await res.json()) as T
      } catch {
        // Malformed body is not retryable — the request itself succeeded.
        throw new ProviderError(`${label} returned a malformed response.`, "invalid_response", res.status)
      }
    } catch (err) {
      if (err instanceof ProviderError) {
        if (!err.retryable) throw err
        lastErr = err
      } else if (err instanceof DOMException && err.name === "AbortError") {
        // Phase 5 — timeout classification.
        lastErr = new ProviderError(`${label} timed out after ${timeoutMs}ms.`, "timeout")
      } else {
        lastErr = new ProviderError(
          `${label} network error: ${err instanceof Error ? err.message : "unknown"}.`,
          "network",
        )
      }
      if (attempt < retries) {
        await sleep(lastErr.retryAfterMs ?? backoffDelay(attempt))
        continue
      }
    }
  }

  throw lastErr ?? new ProviderError(`${label} failed after ${retries + 1} attempts.`, "network")
}
