/**
 * Strip MDX-specific syntax from body content for AI consumption.
 *
 * Removes import/export statements (pure code, no content value).
 * Leaves JSX components intact — many carry semantic data in props
 * (e.g., <MatrixRow label="..." matches="1, 3" />) that would be lost
 * if stripped. AI models handle JSX props well for RAG.
 *
 * Handles:
 * - Single-line and multi-line import/export statements (brace tracking)
 * - Fenced code blocks (``` / ~~~) are preserved — imports/exports inside
 *   code blocks are not stripped
 */

/**
 * Remove import/export statements and collapse resulting blank lines.
 * Preserves content inside fenced code blocks.
 */
export function stripMdxImports(body: string): string {
  const lines = body.split('\n')
  const result: string[] = []
  let inCodeBlock = false
  let stripping = false
  let depth = 0

  for (const line of lines) {
    const trimmed = line.trim()

    // Track fenced code blocks (``` or ~~~)
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inCodeBlock = !inCodeBlock
      result.push(line)
      continue
    }

    // Inside code blocks: keep everything
    if (inCodeBlock) {
      result.push(line)
      continue
    }

    // Continue stripping a multi-line import/export statement
    if (stripping) {
      for (const ch of line) {
        if (ch === '{' || ch === '(') depth++
        if (ch === '}' || ch === ')') depth--
      }
      if (depth <= 0) {
        stripping = false
        depth = 0
      }
      continue
    }

    // Detect top-level import/export statements
    if (/^import\s/.test(trimmed) || /^export\s/.test(trimmed)) {
      // Count open/close braces to detect multi-line statements
      depth = 0
      for (const ch of line) {
        if (ch === '{' || ch === '(') depth++
        if (ch === '}' || ch === ')') depth--
      }
      if (depth > 0) {
        stripping = true
      } else {
        depth = 0
      }
      continue
    }

    result.push(line)
  }

  return result
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
