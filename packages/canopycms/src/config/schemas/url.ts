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
 * `isHttpUrlOrSameOriginPath`'s doc carries the reasoning, including why a protocol-relative
 * `//host` is refused while bare `http://` is accepted.
 */
export const uploadTargetUrlSchema = z
  .string()
  .trim()
  .refine((value) => isHttpUrlOrSameOriginPath(value), {
    message:
      'must be an absolute http(s) URL or a site-relative path beginning with a single "/", with no query or fragment',
  })

/** `editor.previewPrefix`, by `uploadTargetUrlSchema`'s rule: `//host` leaves the scheme open. */
export const previewPrefixSchema = z
  .string()
  .trim()
  .refine((value) => isHttpUrlOrSameOriginPath(value), {
    message:
      'editor.previewPrefix must be an absolute http(s) URL or a site-relative path beginning with a single "/", with no query or fragment',
  })
