/**
 * The editor's public URL, for links written into pull request bodies, and the deep links
 * built on it. The editor reads `?branch=` and `&entry=` (an entry's logical path) on load.
 */

/** Longest editor URL accepted from a client. */
const MAX_CLAIMED_URL_LENGTH = 2048

/** The editor page URL with no query or fragment, or undefined if it is not plain http(s). */
function editorPageUrl(raw: string): string | undefined {
  if (raw.length > MAX_CLAIMED_URL_LENGTH) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (url.username || url.password) return undefined
  return `${url.origin}${url.pathname}`
}

/**
 * The host the request was addressed to: the first `x-forwarded-host` value, else `Host`.
 * Behind canopycms-cdk's CloudFront the Lambda's own Host is the Function URL's, and the
 * viewer-request function overwrites `x-forwarded-host` with the viewer's Host, so a viewer
 * cannot choose it there.
 */
function requestHost(header: (name: string) => string | null): string | undefined {
  const forwarded = header('x-forwarded-host')?.split(',')[0]?.trim()
  const host = forwarded || header('host')?.trim()
  return host || undefined
}

/** `host` as `URL.host` spells it under `protocol`, or undefined if it is not a bare host[:port]. */
function normalizeHost(host: string, protocol: string): string | undefined {
  if (/[\s/\\@?#]/.test(host)) return undefined
  try {
    return new URL(`${protocol}//${host}`).host
  } catch {
    return undefined
  }
}

export interface ResolveEditorUrlInput {
  /** `config.editorUrl`, already validated by the config schema. */
  configured?: string
  /** The page URL the editor client reported. */
  claimed?: string
  /** The request's header getter. */
  header?: (name: string) => string | null
}

/**
 * The editor URL for links: the configured one; else the client-reported page URL when its
 * host is the one the request was addressed to (see requestHost); else undefined. The host
 * check is what stops a request from naming an arbitrary site as the editor.
 */
export function resolveEditorUrl(input: ResolveEditorUrlInput): string | undefined {
  if (input.configured) return editorPageUrl(input.configured)
  if (!input.claimed || !input.header) return undefined
  const claimed = editorPageUrl(input.claimed)
  const host = requestHost(input.header)
  if (!claimed || !host) return undefined
  const url = new URL(claimed)
  return normalizeHost(host, url.protocol) === url.host ? claimed : undefined
}

/** A link to `branch` in the editor at `editorUrl`, optionally opening the entry at `entryPath`. */
export function editorDeepLink(editorUrl: string, branch: string, entryPath?: string): string {
  const url = new URL(editorUrl)
  url.searchParams.set('branch', branch)
  if (entryPath !== undefined) url.searchParams.set('entry', entryPath)
  return url.href
}
