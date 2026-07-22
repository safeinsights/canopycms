/**
 * Pure parser/formatter for `/assets/t/{directives}/{hash32}/{slug}.{ext}`
 * transform URLs. Isomorphic and dependency-free by design: this module has
 * NO imports (not even other files in this directory) so it can be imported
 * from client bundles (via `assetUrl`/`assetSrcSet` in asset-url.ts, exported
 * off the package's main entry) as well as from the server-only transform
 * engine (transform.ts) and the future prod transform Lambda (PR 7), without
 * ever pulling in node:crypto, sharp, or any other server-only dependency.
 *
 * `{directives}` is either the literal identity token (`orig`) or a
 * comma-separated list of `key=value` pairs drawn from:
 *   w={int}   output width - allowlisted to multiples of 160 in [160, 4096]
 *             (bounds cache-stuffing; upscaling is rejected at transform
 *             time via `withoutEnlargement`, not here)
 *   f={fmt}   output format: webp | jpeg | png - when present, the URL's
 *             `{ext}` must equal it exactly
 *   q={int}   quality 1..100 (encoder-dependent)
 *   c={rect}  normalized crop rect `x:y:w:h`, four floats in [0,1] with
 *             x+w<=1 and y+h<=1, w>0 and h>0 (colon-separated - commas are
 *             the directive separator)
 *
 * Duplicate keys, unknown keys, and empty directive strings are rejected.
 * `orig` must appear alone.
 */

/** The identity transform directive name - EXIF-strip only, no other change. */
export const IDENTITY_TRANSFORM_DIRECTIVE = 'orig'

export type OutputFormat = 'webp' | 'jpeg' | 'png'

export interface CropRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** Identity ('orig'): EXIF-strip only, no resize/format/quality change. */
export interface IdentityDirectives {
  readonly identity: true
}

/** Non-identity directive set - every field optional, but at least one is present. */
export interface ResizeDirectives {
  readonly identity: false
  readonly width?: number
  readonly format?: OutputFormat
  readonly quality?: number
  readonly crop?: CropRect
}

export type TransformDirectives = IdentityDirectives | ResizeDirectives

export interface ParsedTransformPath {
  readonly directives: TransformDirectives
  readonly hash32: string
  readonly slug: string
  readonly ext: string
}

export type ParseTransformPathResult =
  | ({ readonly ok: true } & ParsedTransformPath)
  | { readonly ok: false; readonly error: string }

const MIN_WIDTH = 160
const MAX_WIDTH = 4096
const WIDTH_STEP = 160
// Quality is allowlisted (multiples of 5 in [30, 95] - 14 values) for the
// same cache-stuffing reason as width: every accepted directive combination
// becomes a stored cache object in prod, so unbounded q would multiply the
// per-asset variant space by 100. Crop remains the one effectively unbounded
// dimension (editor rects need float precision) - prod mitigation (rate
// limiting / signed crops) is tracked in the design record for the CDK PR.
const MIN_QUALITY = 30
const MAX_QUALITY = 95
const QUALITY_STEP = 5
const CROP_PRECISION = 4

const HASH32_RE = /^[a-f0-9]{32}$/
const SLUG_RE = /^[a-z0-9-]+$/
const EXT_RE = /^[a-z0-9]{1,10}$/
const POSITIVE_INT_RE = /^[1-9][0-9]*$/
// The two alternatives are mutually exclusive on their very first character
// ('0' vs '1'), and neither branch nests a quantifier inside another - each
// character class match advances the position by exactly one, so there is
// exactly one way to parse any matching string (no backtracking ambiguity).
// The security plugin's heuristic flags any alternation-plus-quantifier
// shape regardless; input here is also a single bounded URL path segment,
// not attacker-scalable text.
// eslint-disable-next-line security/detect-unsafe-regex
const UNIT_FLOAT_RE = /^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$/

const KNOWN_DIRECTIVE_KEYS = new Set(['w', 'f', 'q', 'c'])

function isOutputFormat(value: string): value is OutputFormat {
  return value === 'webp' || value === 'jpeg' || value === 'png'
}

/** True if `width` is on the allowlist: a multiple of 160 in [160, 4096]. */
export function isAllowedTransformWidth(width: number): boolean {
  return (
    Number.isInteger(width) && width >= MIN_WIDTH && width <= MAX_WIDTH && width % WIDTH_STEP === 0
  )
}

function parseWidth(value: string): number | null {
  if (!POSITIVE_INT_RE.test(value)) return null
  const n = Number(value)
  return isAllowedTransformWidth(n) ? n : null
}

/** True if `quality` is on the allowlist: a multiple of 5 in [30, 95]. */
export function isAllowedTransformQuality(quality: number): boolean {
  return (
    Number.isInteger(quality) &&
    quality >= MIN_QUALITY &&
    quality <= MAX_QUALITY &&
    quality % QUALITY_STEP === 0
  )
}

function parseQuality(value: string): number | null {
  if (!POSITIVE_INT_RE.test(value)) return null
  const n = Number(value)
  return isAllowedTransformQuality(n) ? n : null
}

function parseUnitFloat(value: string): number | null {
  if (!UNIT_FLOAT_RE.test(value)) return null
  const n = Number(value)
  return n >= 0 && n <= 1 ? n : null
}

/**
 * True when x, y, w, h describe a valid normalized crop rect: all four values
 * finite and in [0,1], w and h strictly positive, and the rect fits within
 * bounds (x+w<=1, y+h<=1). Shared by the URL-directive parser (`parseCrop`,
 * below, from a `x:y:w:h` string) and image field value validation (from a
 * `{x,y,w,h}` object, in validation/entry-validator.ts) so both enforce
 * identical constraints.
 */
export function isValidCropRect(x: number, y: number, w: number, h: number): boolean {
  for (const n of [x, y, w, h]) {
    if (!Number.isFinite(n) || n < 0 || n > 1) return false
  }
  if (w <= 0 || h <= 0) return false
  if (x + w > 1 || y + h > 1) return false
  return true
}

function parseCrop(value: string): CropRect | null {
  const parts = value.split(':')
  if (parts.length !== 4) return null
  const nums = parts.map(parseUnitFloat)
  if (nums.some((n) => n === null)) return null
  const [x, y, w, h] = nums as number[]
  if (!isValidCropRect(x, y, w, h)) return null
  return { x, y, w, h }
}

function formatUnitFloat(n: number): string {
  return n.toFixed(CROP_PRECISION)
}

function err(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

/**
 * Parse a `key=value,key=value` directive string (everything between
 * `assets/t/` and the hash32 segment) into a `TransformDirectives`, or
 * `orig` into the identity directive.
 */
function parseDirectivesString(
  raw: string,
): { ok: true; directives: TransformDirectives } | { ok: false; error: string } {
  if (raw === IDENTITY_TRANSFORM_DIRECTIVE) {
    return { ok: true, directives: { identity: true } }
  }
  if (raw.length === 0) {
    return err('Empty directives')
  }

  const seen = new Set<string>()
  let width: number | undefined
  let format: OutputFormat | undefined
  let quality: number | undefined
  let crop: CropRect | undefined

  for (const pair of raw.split(',')) {
    const eqIdx = pair.indexOf('=')
    // Also catches `orig` combined with other directives (e.g. `orig,w=320`):
    // `orig` has no `=`, so it falls into this same malformed-pair branch -
    // `orig` is only ever valid when it is the entire directives string.
    if (eqIdx <= 0 || eqIdx === pair.length - 1) {
      return err(`Malformed directive: '${pair}'`)
    }
    const key = pair.slice(0, eqIdx)
    const value = pair.slice(eqIdx + 1)

    if (!KNOWN_DIRECTIVE_KEYS.has(key)) {
      return err(`Unknown directive key: '${key}'`)
    }
    if (seen.has(key)) {
      return err(`Duplicate directive key: '${key}'`)
    }
    seen.add(key)

    switch (key) {
      case 'w': {
        const w = parseWidth(value)
        if (w === null) return err(`Invalid width: '${value}'`)
        width = w
        break
      }
      case 'f': {
        if (!isOutputFormat(value)) return err(`Invalid format: '${value}'`)
        format = value
        break
      }
      case 'q': {
        const q = parseQuality(value)
        if (q === null) return err(`Invalid quality: '${value}'`)
        quality = q
        break
      }
      case 'c': {
        const c = parseCrop(value)
        if (!c) return err(`Invalid crop: '${value}'`)
        crop = c
        break
      }
    }
  }

  return { ok: true, directives: { identity: false, width, format, quality, crop } }
}

/**
 * Parse the three path segments after the `assets/t/` prefix:
 * `[directivesRaw, hash32, "{slug}.{ext}"]`. The raw route strips the
 * `assets/t/` prefix and splits the remaining key by `/` before calling this.
 */
export function parseTransformPath(segments: readonly string[]): ParseTransformPathResult {
  if (segments.length !== 3) {
    return err(`Expected 3 path segments (directives/hash32/slug.ext), got ${segments.length}`)
  }
  const [directivesRaw, hash32, slugExt] = segments

  if (!HASH32_RE.test(hash32)) {
    return err(`Invalid hash32: '${hash32}'`)
  }

  const lastDot = slugExt.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === slugExt.length - 1) {
    return err(`Invalid slug.ext segment: '${slugExt}'`)
  }
  const slug = slugExt.slice(0, lastDot)
  const ext = slugExt.slice(lastDot + 1)
  if (!SLUG_RE.test(slug)) {
    return err(`Invalid slug: '${slug}'`)
  }
  if (!EXT_RE.test(ext)) {
    return err(`Invalid ext: '${ext}'`)
  }

  const parsedDirectives = parseDirectivesString(directivesRaw)
  if (!parsedDirectives.ok) {
    return parsedDirectives
  }

  const { directives } = parsedDirectives
  if (!directives.identity && directives.format !== undefined && directives.format !== ext) {
    return err(`Extension '${ext}' does not match format '${directives.format}'`)
  }

  return { ok: true, directives, hash32, slug, ext }
}

/**
 * Canonical string form of a directive set, so equivalent directive sets
 * (different key order, different float formatting) always map to the same
 * cache key. Order is fixed alphabetically by key: c, f, q, w.
 */
export function formatDirectives(directives: TransformDirectives): string {
  if (directives.identity) {
    return IDENTITY_TRANSFORM_DIRECTIVE
  }

  const parts: string[] = []
  if (directives.crop) {
    const { x, y, w, h } = directives.crop
    parts.push(
      `c=${formatUnitFloat(x)}:${formatUnitFloat(y)}:${formatUnitFloat(w)}:${formatUnitFloat(h)}`,
    )
  }
  if (directives.format !== undefined) {
    parts.push(`f=${directives.format}`)
  }
  if (directives.quality !== undefined) {
    parts.push(`q=${directives.quality}`)
  }
  if (directives.width !== undefined) {
    parts.push(`w=${directives.width}`)
  }

  // A validly-parsed ResizeDirectives always has at least one field set
  // (parseDirectivesString rejects an empty directive string), but a
  // programmatically-constructed one (e.g. from asset-url.ts's merge logic)
  // could end up all-undefined - fall back to identity rather than emit an
  // empty directives segment.
  return parts.length > 0 ? parts.join(',') : IDENTITY_TRANSFORM_DIRECTIVE
}
