/**
 * Computes the `x-amz-content-sha256` header CloudFront's Origin Access Control (OAC) requires
 * for SigV4-signed origin requests that carry a body: OAC signs the request but never hashes the
 * payload itself, so the viewer request must carry this header or the Function URL returns 403.
 * See docs/deploying-to-aws.md for the deployment topology.
 *
 * Uses WebCrypto (secure-context browsers, Node >= 18) to hash the exact bytes sent.
 */

/**
 * Hash a string request body (e.g. a JSON-serialized payload). Returns `undefined` when
 * WebCrypto is unavailable (a dev server over plain http, not a secure context) so callers can
 * skip the header instead of throwing — production is always https.
 */
export async function computeContentSha256Hex(body: string): Promise<string | undefined> {
  return computeContentSha256HexFromBytes(new TextEncoder().encode(body))
}

/**
 * Hash a raw-bytes request body (e.g. an ArrayBuffer or Blob upload). Not usable for `FormData`
 * bodies — the multipart boundary is generated at send time, after the request would already
 * need to be signed.
 */
export async function computeContentSha256HexFromBytes(
  bytes: BufferSource,
): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return undefined

  const digest = await subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
