/**
 * Convert MDX/Markdown body content to plain prose text, suitable for a
 * search index or any other consumer that wants "just the words".
 *
 * This is deliberately a *different* transform from `stripMdxImports`
 * (strip-mdx.ts): that one is tuned for AI/RAG consumption and intentionally
 * leaves JSX components intact, because their props often carry semantic
 * data a model can use. `toPlainText` has the opposite goal — it removes ALL
 * markup (JSX tags, JSX expressions, markdown syntax) and keeps only the
 * prose, so **paired custom components lose their tags but keep their
 * children's text**. That distinction is the whole reason this function
 * exists: a hand-rolled plaintext stripper that treats a paired component
 * like `<Callout>...</Callout>` as one opaque unit and deletes it wholesale
 * silently drops every word inside it from the search index. `toPlainText`
 * strips the `<Callout>`/`</Callout>` delimiters but keeps the sentence
 * between them.
 *
 * Pipeline (each step operates on the previous step's output):
 * 1. Strip YAML frontmatter (via `gray-matter`, the same parser
 *    `content-store.ts` uses for `.md`/`.mdx` bodies).
 * 2. Strip `import`/`export` statements (via `stripMdxImports`), which also
 *    protects fenced code blocks from every later step.
 * 3. Mask fenced code blocks and inline code spans, capturing their content
 *    (fence markers / backticks are discarded, the code text is kept).
 * 4. Strip JSX/HTML tags — opening, closing, and self-closing — leaving
 *    whatever text sits between them in place. This is a single global
 *    replace, not a matched-pair walk: because we never need the tag name or
 *    the children as a unit (unlike `applyComponentTransforms`, which calls
 *    an adopter transform per component), deleting every tag occurrence and
 *    leaving the surrounding text untouched handles nesting for free.
 * 5. Strip JSX expressions (`{...}`, including nested braces) — these are
 *    code, not prose.
 * 6. Strip common Markdown syntax: headings, emphasis/strikethrough, links
 *    (keep the link text, drop the URL), images (keep alt text), blockquote
 *    markers, list markers, and thematic breaks.
 * 7. Restore the masked code from step 3 as plain text.
 * 8. Collapse whitespace: trim each line, collapse runs of blank lines,
 *    trim the result. Paragraph breaks (single blank lines) are preserved —
 *    this does not flatten the output to one line.
 */

import matter from 'gray-matter'
import { stripMdxImports } from './strip-mdx'

/**
 * Masking markers use `@` right after `<` (and before the closing `>`),
 * e.g. `<@B0@>`. `@` is not a valid JSX tag-name start (`[A-Za-z]` only), so
 * TAG_RE below can never mistake the marker for a real tag — unlike
 * transform-components.ts's `<<CODEBLOCK0>>` convention, which is safe
 * there only because that module never runs a *generic* tag-stripping regex
 * over its masked text (this one does: `<CODEBLOCK0>` inside `<<...>>`
 * reads as a valid tag name to a naive tag matcher, which is exactly the
 * bug this format avoids). `@` also doesn't participate in any of the
 * Markdown-syntax regexes below, so a marker surviving to that stage is
 * inert there too.
 */
const BLOCK_PREFIX = '<@B'
const BLOCK_SUFFIX = '@>'
const BLOCK_RESTORE_RE = /<@B(\d+)@>/g

const INLINE_PREFIX = '<@I'
const INLINE_SUFFIX = '@>'
const INLINE_RESTORE_RE = /<@I(\d+)@>/g

/** JSX attribute content: skips quoted strings so a `>` inside `title="a > b"` doesn't end the tag early. */
const ATTR_CONTENT = `(?:[^<>"']|"[^"]*"|'[^']*')*`

/**
 * Matches an opening, closing, or self-closing JSX/HTML tag, or a fragment (`<>`/`</>`).
 *
 * No trailing `\s*` before the final `\/?>`: `ATTR_CONTENT`'s `[^<>"']` alternative already
 * matches whitespace, so a trailing `\s*` on top of it lets the engine split any whitespace run
 * between the two in every possible proportion. On an unterminated tag (no closing `>` in the
 * input) followed by a long whitespace run, that ambiguity is polynomial-ReDoS shaped (CodeQL
 * `js/polynomial-redos`): matching cost is quadratic in the run length before the engine gives up
 * and backtracks to try the next start position. Measured on a 128 KB whitespace tail: ~26s with
 * the redundant `\s*`, ~1ms without it. `ATTR_CONTENT` already absorbs the trailing whitespace on
 * its own, so removing the `\s*` changes no matched output.
 */
const TAG_RE = new RegExp(`<\\/?([A-Za-z][\\w.-]*)?(?:\\s${ATTR_CONTENT})?\\/?>`, 'g')

const COMMENT_OPEN = '<!--'
const COMMENT_CLOSE = '-->'

/**
 * Strip well-formed HTML/MDX comments (`<!-- ... -->`), including their contents.
 *
 * `TAG_RE` cannot do this: its tag-name group is `[A-Za-z]`-initial, so `<!--` matches neither
 * the name nor the bare-fragment form, and both delimiters plus every word between them survive
 * into the extracted text. Authoring notes then show up verbatim in a search index or an AI
 * export — text the author explicitly marked as not-for-readers.
 *
 * A hand-rolled `indexOf` scan rather than `/<!--[\s\S]*?-->/g`, for the same reason
 * `maskFencedCodeBlocks` above is hand-rolled: that lazy pattern has no bound on how far it
 * scans looking for a closer, so on input with many unterminated `<!--` openers the engine
 * exhausts to end-of-string at every one of them — quadratic in the number of openers, the same
 * polynomial-ReDoS shape documented on `TAG_RE` and the fence scanner. This scan visits each
 * character at most once.
 *
 * An UNTERMINATED `<!--` is deliberately left alone rather than swallowing the rest of the
 * document. HTML would run such a comment to EOF, but here the input is prose being extracted
 * for search and AI consumption, where silently dropping everything after a mistyped delimiter
 * loses far more than it protects. The stray `<!--` survives as literal text, which is visible
 * and fixable; a vanished second half of a document is neither.
 *
 * Runs while fenced/inline code is still masked, so a comment shown as example code keeps its
 * delimiters.
 */
function stripHtmlComments(text: string): string {
  let searchFrom = 0
  let open = text.indexOf(COMMENT_OPEN, searchFrom)
  if (open === -1) return text

  let out = ''
  while (open !== -1) {
    const close = text.indexOf(COMMENT_CLOSE, open + COMMENT_OPEN.length)
    if (close === -1) break
    out += text.slice(searchFrom, open) + ' '
    searchFrom = close + COMMENT_CLOSE.length
    open = text.indexOf(COMMENT_OPEN, searchFrom)
  }

  return out + text.slice(searchFrom)
}

/** True if `line` is a valid closing fence line for `marker` ("```" or "~~~"): the marker
 * followed by nothing but whitespace through end of line — matching what `\1\s*$` required in
 * the regex this replaced. */
function isFenceCloseLine(line: string, marker: string): boolean {
  return line.startsWith(marker) && /^\s*$/.test(line.slice(marker.length))
}

/**
 * Mask fenced code blocks (` ``` `/`~~~`), capturing each block's *content* so `restore`
 * re-inserts plain text — no fence markers, no language tag.
 *
 * A hand-rolled line scan, not `/^(```|~~~).*\n([\s\S]*?)\n\1\s*$/gm`: that regex is a second
 * polynomial-ReDoS shape (measured ~9s on ~530KB of body text with many unclosed fence openers,
 * a plausible authoring accident — the same trigger class as `TAG_RE` above, in the same
 * function). The lazy `[\s\S]*?` has no bound on how far it must scan looking for a closing
 * `\1` that, for an unclosed fence, never arrives — it exhausts to the end of the string before
 * giving up on that starting line, and `/gm` retries the same exhaustive scan at every
 * subsequent fence-opener line, which is quadratic in the number of unclosed openers.
 *
 * This scans each line once. `nextCloseLine` is precomputed per marker type via a single
 * backward pass, so any opener's nearest closer (or "none exists") is an O(1) lookup rather than
 * a fresh forward scan — the change that makes the whole function O(n) regardless of how many
 * fences are opened and never closed.
 */
function maskFencedCodeBlocks(body: string, blocks: string[]): string {
  const lines = body.split('\n')
  const lineCount = lines.length

  // nextCloseLine[marker][i] = the nearest index >= i that closes `marker`, or -1 if none exists
  // at or after i. Built right-to-left so each entry is O(1) given the next one.
  const nextCloseLine = {
    '```': new Array<number>(lineCount + 1).fill(-1),
    '~~~': new Array<number>(lineCount + 1).fill(-1),
  }
  for (let i = lineCount - 1; i >= 0; i--) {
    nextCloseLine['```'][i] = isFenceCloseLine(lines[i], '```') ? i : nextCloseLine['```'][i + 1]
    nextCloseLine['~~~'][i] = isFenceCloseLine(lines[i], '~~~') ? i : nextCloseLine['~~~'][i + 1]
  }

  const outLines: string[] = []
  let i = 0
  while (i < lineCount) {
    const line = lines[i]
    const marker = line.startsWith('```') ? '```' : line.startsWith('~~~') ? '~~~' : null

    // A closer can never be the very next line: the original pattern requires TWO separate `\n`
    // matches between the opener and `\1` (one ending the opener's line, one immediately before
    // the closer), so even zero-width content needs a line of its own between them.
    const searchFrom = i + 2
    const closeIndex = marker && searchFrom < lineCount ? nextCloseLine[marker][searchFrom] : -1

    if (!marker || closeIndex === -1) {
      outLines.push(line)
      i++
      continue
    }

    const content = lines.slice(i + 1, closeIndex).join('\n')
    const idx = blocks.length
    blocks.push(content)
    // Matches the replaced regex's `\n${...}\n` callback wrapping: the placeholder becomes its
    // own blank-line-delimited chunk. (Any resulting difference in surrounding blank-line COUNT
    // is immaterial -- collapseWhitespace normalizes runs of 3+ newlines down to one blank line
    // before this ever reaches a caller.)
    outLines.push('', `${BLOCK_PREFIX}${idx}${BLOCK_SUFFIX}`, '')
    i = closeIndex + 1
  }
  return outLines.join('\n')
}

/**
 * Mask fenced code blocks and inline code spans, capturing their *content*
 * (not the raw fenced/backticked text) so `restore` re-inserts plain text —
 * no fence markers, no language tag, no backticks.
 */
function maskCode(body: string): { masked: string; restore: (s: string) => string } {
  const blocks: string[] = []
  const inlines: string[] = []

  let masked = maskFencedCodeBlocks(body, blocks)

  masked = masked.replace(
    /``(.+?)``|`([^`]+)`/g,
    (_match, double: string | undefined, single: string | undefined) => {
      const idx = inlines.length
      inlines.push((double ?? single ?? '').trim())
      return `${INLINE_PREFIX}${idx}${INLINE_SUFFIX}`
    },
  )

  return {
    masked,
    restore: (s: string) => {
      s = s.replace(INLINE_RESTORE_RE, (_match, i: string) => inlines[Number(i)])
      s = s.replace(BLOCK_RESTORE_RE, (_match, i: string) => blocks[Number(i)])
      return s
    },
  }
}

/**
 * Remove balanced `{...}` groups (JSX expressions), including nested braces,
 * in a single pass. Each removed top-level group collapses to one space so
 * surrounding words don't merge.
 */
function stripBraceExpressions(text: string): string {
  let result = ''
  let depth = 0
  for (const ch of text) {
    if (ch === '{') {
      if (depth === 0) result += ' '
      depth++
      continue
    }
    if (ch === '}') {
      if (depth > 0) depth--
      continue
    }
    if (depth === 0) result += ch
  }
  return result
}

/** Strip common Markdown syntax, keeping the human-readable text. */
function stripMarkdownSyntax(text: string): string {
  return (
    text
      // Headings: leading `#` markers
      .replace(/^ {0,3}#{1,6}\s+/gm, '')
      // Blockquotes: leading `>` markers (possibly nested). Each repetition
      // of the outer `+` consumes a mandatory `>` first, so it can't loop on
      // an empty match — linear, despite the nested-quantifier shape the
      // linter's heuristic flags.
      // eslint-disable-next-line security/detect-unsafe-regex
      .replace(/^ {0,3}(?:>\s?)+/gm, '')
      // Thematic breaks: a line of 3+ `-`, `*`, or `_` (optionally
      // space-separated). The backreference (`\1`) pins every repetition to
      // the same captured character, which the linter's heuristic doesn't
      // model — same false-positive shape as above.
      // eslint-disable-next-line security/detect-unsafe-regex
      .replace(/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/gm, '')
      // List markers: bullet or ordered
      .replace(/^(\s*)[-*+]\s+/gm, '$1')
      .replace(/^(\s*)\d+[.)]\s+/gm, '$1')
      // Images: keep alt text, drop the URL entirely
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Links: keep the link text, drop the URL
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Strikethrough / bold / italic — longest markers first so `**` isn't
      // consumed as two `*` matches
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/\b_([^_]+)_\b/g, '$1')
  )
}

/** Trim each line, collapse runs of blank lines, and trim the whole result. Preserves paragraph breaks. */
function collapseWhitespace(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Convert MDX/Markdown body content to plain prose text.
 *
 * See the module doc above for the full pipeline and why this exists as a
 * distinct transform from `stripMdxImports`. In short: frontmatter, code
 * fences, inline code, JSX tags/expressions, and Markdown syntax are all
 * stripped down to their human-readable text — code content and link/image
 * text are kept, everything else is discarded. Paired custom components
 * lose only their tags; the prose between them survives.
 *
 * HTML/MDX comments (`<!-- ... -->`) are removed along with their contents:
 * an authoring note is text the author marked as not-for-readers, so it does
 * not belong in a search index or an AI export.
 *
 * Output preserves paragraph breaks (blank lines) but is not further
 * chunked, weighted, or field-selected — composing that into a search
 * document is left to the caller, since that logic is where adopter search
 * indexes genuinely diverge (see docs/adopter-migration.md).
 */
export function toPlainText(markdown: string): string {
  const { content } = matter(markdown)
  const withoutImports = stripMdxImports(content)
  const { masked, restore } = maskCode(withoutImports)

  let result = masked
  result = stripHtmlComments(result)
  result = result.replace(TAG_RE, ' ')
  result = stripBraceExpressions(result)
  result = stripMarkdownSyntax(result)
  result = restore(result)
  result = collapseWhitespace(result)

  return result
}
