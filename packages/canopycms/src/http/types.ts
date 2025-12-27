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
 * Create a JSON response with the given body and status code.
 */
export function jsonResponse<T>(
  body: T,
  status = 200,
  headers?: Record<string, string>
): CanopyResponse<T> {
  return { status, body, headers }
}
