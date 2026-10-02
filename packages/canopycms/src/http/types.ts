/** Framework-agnostic HTTP request: only what CanopyCMS actually needs. */
export interface CanopyRequest {
  readonly method: string

  readonly url: string

  /** Case-insensitive; null when the header is absent. */
  header(name: string): string | null

  /** Undefined for GET requests and empty bodies. */
  json(): Promise<unknown>

  /**
   * The raw body bytes, bypassing JSON parsing. Optional, so that adapters
   * without non-JSON bodies (and bare test mocks) still compile.
   *
   * As with the platform Request, the body stream is consumed ONCE: a caller
   * using this must not also call `json()` or `formData()`.
   */
  rawBody?(): Promise<Uint8Array>

  /** Optional, and single-use, for the same reasons as `rawBody`. */
  formData?(): Promise<FormData>
}

/** Framework-agnostic HTTP response. */
export interface CanopyResponse<T = unknown> {
  readonly status: number
  readonly body: T
  readonly headers?: Record<string, string>
}

/**
 * A binary response (image/PDF bytes). The `kind` discriminant lets adapters
 * dispatch without a cast: `body` here is arbitrary bytes or a stream of them,
 * not a JSON-serializable value.
 */
export interface CanopyBinaryResponse {
  readonly kind: 'binary'
  readonly status: number
  readonly body: Uint8Array | ReadableStream<Uint8Array>
  readonly headers: {
    contentType?: string
    contentDisposition?: string
    cacheControl?: string
    etag?: string
  }
}

export function jsonResponse<T>(
  body: T,
  status = 200,
  headers?: Record<string, string>,
): CanopyResponse<T> {
  return { status, body, headers }
}

/**
 * Distinguishes `CanopyBinaryResponse` from any other route result (neither
 * `ApiResponse` nor `CanopyResponse` declares `kind`), which is how adapters
 * and the core handler decide to pass a result through or wrap it in JSON.
 */
export function isCanopyBinaryResponse(value: unknown): value is CanopyBinaryResponse {
  return (
    typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'binary'
  )
}
