/**
 * Framework-agnostic HTTP request interface.
 * Minimal surface area - only what CanopyCMS actually needs.
 */
export interface CanopyRequest {
  /** HTTP method (GET, POST, PUT, DELETE, etc.) */
  readonly method: string

  /** Full request URL as string */
  readonly url: string

  /**
   * Get request header value (case-insensitive).
   * Returns null if header not present.
   */
  header(name: string): string | null

  /**
   * Parse request body as JSON.
   * Returns undefined for GET requests or empty bodies.
   */
  json(): Promise<unknown>

  /**
   * Read the raw request body as bytes, bypassing JSON parsing.
   * Optional: only wired by adapters that need to support non-JSON bodies
   * (e.g. proxied binary/multipart uploads). Bare CanopyRequest mocks/test
   * harnesses that omit this keep compiling.
   *
   * Like the underlying platform Request, the body stream can only be
   * consumed once - callers must not also call `json()`/`formData()` on the
   * same request.
   */
  rawBody?(): Promise<Uint8Array>

  /**
   * Parse the request body as multipart/form-data.
   * Optional for the same reason as `rawBody` above.
   */
  formData?(): Promise<FormData>
}

/**
 * Framework-agnostic HTTP response.
 * Represents the response data to be sent back.
 */
export interface CanopyResponse<T = unknown> {
  readonly status: number
  readonly body: T
  readonly headers?: Record<string, string>
}

/**
 * Framework-agnostic binary HTTP response (e.g. serving image/PDF bytes).
 * Distinct from `CanopyResponse` via the `kind` discriminant so adapters can
 * dispatch on response shape without a cast: `body` is arbitrary bytes
 * (or a stream of them), not a JSON-serializable value.
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

/**
 * Create a JSON response with the given body and status code.
 */
export function jsonResponse<T>(
  body: T,
  status = 200,
  headers?: Record<string, string>,
): CanopyResponse<T> {
  return { status, body, headers }
}

/**
 * Type guard distinguishing `CanopyBinaryResponse` from any other route
 * result (`ApiResponse`/`CanopyResponse`, neither of which declare `kind`).
 * Framework adapters and the core handler use this to decide whether to
 * pass a route result through untouched or wrap it via `jsonResponse`.
 */
export function isCanopyBinaryResponse(value: unknown): value is CanopyBinaryResponse {
  return (
    typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'binary'
  )
}
