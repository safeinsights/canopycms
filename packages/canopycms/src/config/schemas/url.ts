/**
 * Zod schemas for adopter-configured URL values.
 *
 * Deliberately a separate file rather than an addition to `config.ts`: `config.ts` already
 * imports `media.ts`, and `media.ts` needs these, so defining them there would close a cycle
 * that `.dependency-cruiser.mjs`'s `no-circular` rule fails the build on.
 *
 * These are thin wrappers. The rule itself lives in `utils/sanitize-href.ts` alongside the
 * package's only other http(s) allowlist, so config validation and content sanitization cannot
 * drift into disagreeing about which URLs are acceptable.
 */

import { z } from 'zod'

import { isHttpUrlOrSameOriginPath } from '../../utils/sanitize-href'

/**
 * Where the browser POSTs a presigned direct upload (`media.uploadUrl`).
 *
 * Stricter than `assetMountUrlSchema` by exactly one case — no protocol-relative `//host` —
 * because that spelling is ambiguous rather than insecure: it resolves to http or https
 * depending on the editor page issuing the upload, so the config would not determine where a
 * live credential is sent. `isHttpUrlOrSameOriginPath`'s doc carries the full reasoning,
 * including why bare `http://` is nonetheless accepted.
 *
 * "Exactly one case" is measured, not asserted: a census over every 4-character string
 * drawn from an 11-symbol alphabet (slash, backslash, dot, colon, %2e, ?, #, tab, and three
 * letters), plus hand-written shapes, found 39 values the two schemas treat differently — and
 * every one is a literal `//host` (three only after `.trim()` strips a leading tab).
 */
export const uploadTargetUrlSchema = z
  .string()
  .trim()
  .refine((value) => isHttpUrlOrSameOriginPath(value), {
    message:
      'must be an absolute http(s) URL or a site-relative path beginning with a single "/", with no query or fragment',
  })

/**
 * Where `/assets/…` is mounted for the editor's own previews (`media.publicBaseUrl`).
 *
 * Accepts an absolute http(s) URL, a protocol-relative `//host` URL, or a site-relative path
 * (see `.claude/future-tasks/editor-asset-mount-topology.md` option 1 — the `basePath` fallback
 * in `editor/context/AssetContext.tsx` exists for sites that need one and can't set an absolute
 * value). Rejects non-http(s) schemes: a plain `z.string().url()` check would accept
 * `publicBaseUrl: 'mailto:a@b.c'` and produce `/mailto:a@b.c/assets/…` at render time.
 */
export const assetMountUrlSchema = z
  .string()
  .trim()
  .refine((value) => isHttpUrlOrSameOriginPath(value, { allowProtocolRelative: true }), {
    message:
      'must be an absolute http(s) URL, a protocol-relative "//host" URL, or a site-relative path beginning with a single "/", with no query or fragment',
  })
