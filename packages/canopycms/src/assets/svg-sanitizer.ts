/**
 * SVG sanitization. Server-only - never import from client/editor code.
 *
 * Sanitizer choice: the design record (.claude/future-tasks/assets-media-system.md)
 * suggested `dompurify` + a lightweight DOM shim (e.g. `linkedom`) in place of the
 * heavier `jsdom`. In practice that pairing is unsafe: DOMPurify's own README warns
 * that immature DOM shims can cause it to fail in ways that produce an XSS hole even
 * when DOMPurify itself behaves correctly, and that is exactly what was reproduced
 * here - `createDOMPurify(linkedomWindow).sanitize(dirtySvg)` returned the INPUT
 * UNCHANGED (a `<script>`, `onload=`, and `<foreignObject>` all survived), because
 * linkedom's window has no `NodeFilter` global and DOMPurify silently no-ops when it
 * doesn't recognize the environment as supported. That is a dangerous failure mode
 * for a security boundary, so this module uses `sanitize-html` instead: it works
 * directly on the parser tree (htmlparser2, no DOM shim to be incomplete), is
 * actively maintained, and - verified empirically - correctly strips scripts, event
 * handler attributes, and `foreignObject` while preserving a valid, still-parseable
 * SVG document.
 *
 * Allowlist-based (not blocklist): only elements/attributes known to be safe survive.
 * `href`/`xlink:href` are further restricted to local fragment references (`#...`) so
 * `<use>`/`<a>` can reference in-document defs but can never point at an external URL
 * (tracking pixels, `javascript:` URLs, etc.) - sanitize-html's tag-level scheme
 * allowlisting does not cover attribute name patterns like this, so it is enforced
 * directly in `transformTags` below.
 */

import sanitizeHtml from 'sanitize-html'

const ALLOWED_SVG_TAGS = [
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'title',
  'desc',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'path',
  'text',
  'tspan',
  'textPath',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'pattern',
  'filter',
  'feGaussianBlur',
  'feOffset',
  'feBlend',
  'feColorMatrix',
  'feComponentTransfer',
  'feFuncA',
  'feFuncR',
  'feFuncG',
  'feFuncB',
  'feComposite',
  'feFlood',
  'feMerge',
  'feMergeNode',
  'feMorphology',
  'feTile',
  'feTurbulence',
  'feDropShadow',
  'feDisplacementMap',
  'image',
  'a',
  'marker',
  'metadata',
]

const ALLOWED_SVG_ATTRS = [
  'id',
  'class',
  'style',
  'transform',
  'fill',
  'fill-rule',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-opacity',
  'opacity',
  'd',
  'x',
  'y',
  'width',
  'height',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
  'viewBox',
  'preserveAspectRatio',
  'xmlns',
  'xmlns:xlink',
  'version',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientUnits',
  'gradientTransform',
  'patternUnits',
  'patternTransform',
  'href',
  'xlink:href',
  'clip-path',
  'mask',
  'filter',
  'font-family',
  'font-size',
  'font-weight',
  'text-anchor',
  'dx',
  'dy',
  'marker-start',
  'marker-mid',
  'marker-end',
]

/**
 * Elements whose entire subtree (tags AND text) is discarded when they are not
 * in the allowlist. Without this, sanitize-html's default `disallowedTagsMode:
 * 'discard'` removes the tag itself but leaves loose text content behind (e.g.
 * a stripped `<foreignObject><div>evil</div></foreignObject>` would otherwise
 * leave a bare "evil" text node in the sanitized output).
 */
const NON_TEXT_TAGS = ['script', 'style', 'textarea', 'option', 'foreignObject']

/**
 * Presentation attributes (beyond `style`) whose SVG grammar accepts a
 * `<funciri>` (`url(...)`) value - `fill`/`stroke` reference paint servers
 * (gradients/patterns), `filter`/`mask`/`clip-path` reference filter-effect
 * elements, and the three `marker-*` attributes reference `<marker>`
 * elements. Every one of these is in `ALLOWED_SVG_ATTRS`, so every one of
 * them is a route for the same external-fetch beacon `style`'s `url(...)`
 * hardening (below) already closes: `<rect fill="url(https://evil/beacon)">`
 * fetches externally the moment the SVG is opened as a document, exactly
 * like a `style="background:url(...)"` would.
 */
const URL_BEARING_ATTRS = new Set([
  'style',
  'fill',
  'stroke',
  'filter',
  'mask',
  'clip-path',
  'marker-start',
  'marker-mid',
  'marker-end',
])

/**
 * True when `value` is safe for a URL-bearing presentation attribute: either
 * it has no `url(...)` funciri and no backslash at all (the common case -
 * plain colors, `none`, etc.), or its only `url(...)` reference is a local
 * fragment (`url(#foo)`) - the same in-document-only allowance `href`/
 * `xlink:href` get, and exactly what gradients/filters/markers legitimately
 * need to reference document-local `<linearGradient>`/`<filter>`/`<marker>`
 * defs. Backslashes are rejected unconditionally (even alongside an
 * otherwise-local `url(#foo)`): CSS escapes (e.g. `\75 rl(...)` -> `url(...)`)
 * let a crafted value slip past a plain `url(` text match yet still resolve
 * to an external fetch in the browser's CSS/SVG value parser, and
 * backslashes have no legitimate use in any of these attribute values.
 */
function isSafeUrlBearingValue(value: string): boolean {
  if (value.includes('\\')) return false
  const urlMatches = value.matchAll(/url\s*\(\s*(['"]?)\s*([^)'"]*?)\s*\1\s*\)/gi)
  let sawUrl = false
  for (const match of urlMatches) {
    sawUrl = true
    if (!match[2].startsWith('#')) return false
  }
  return sawUrl ? true : !/url\s*\(/i.test(value)
}

/**
 * Sanitize an SVG document (as text). Strips scripts, event-handler attributes,
 * `<foreignObject>` (and its content), inline `<style>` (CSS injection surface),
 * any `href`/`xlink:href` that isn't a local fragment reference, and any
 * `url(...)` reference on a paint/filter/marker attribute that isn't a local
 * fragment reference (external-fetch tracking beacon).
 *
 * Input must already be confirmed to be an SVG document (see `sniffSvg` in
 * pipeline.ts) - this function does not re-validate the root element.
 */
export function sanitizeSvg(svgText: string): string {
  return sanitizeHtml(svgText, {
    allowedTags: ALLOWED_SVG_TAGS,
    allowedAttributes: { '*': ALLOWED_SVG_ATTRS },
    nonTextTags: NON_TEXT_TAGS,
    // xmlMode makes htmlparser2 treat this as XML (self-closing tags, no HTML
    // element-specific parsing quirks) rather than HTML, which matters for SVG.
    parser: { xmlMode: true, decodeEntities: true },
    transformTags: {
      '*': (tagName, attribs) => {
        const filtered: Record<string, string> = {}
        for (const [key, value] of Object.entries(attribs)) {
          if ((key === 'href' || key === 'xlink:href') && !value.startsWith('#')) {
            continue // drop external/non-local references
          }
          if (URL_BEARING_ATTRS.has(key) && !isSafeUrlBearingValue(value)) {
            continue // drop external/non-local url(...) references (or any backslash)
          }
          filtered[key] = value
        }
        return { tagName, attribs: filtered }
      },
    },
  })
}
