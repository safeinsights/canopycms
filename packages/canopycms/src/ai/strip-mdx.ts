/**
 * Strip MDX-specific syntax from body content for AI consumption.
 *
 * Removes import/export statements (pure code, no content value) and collapses the blank
 * lines left behind. Leaves JSX components intact — many carry semantic data in props (e.g.,
 * <MatrixRow label="..." matches="1, 3" />) that would be lost if stripped; AI models handle
 * JSX props well for RAG. Handles both single-line and multi-line (brace-tracked) statements;
 * fenced code blocks (``` / ~~~) are preserved untouched.
 */
export function stripMdxImports(body: string): string {
  const lines = body.split('\n')
  const result: string[] = []
  let inCodeBlock = false
  let stripping = false
  let depth = 0

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inCodeBlock = !inCodeBlock
      result.push(line)
      continue
    }

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

    if (/^import\s/.test(trimmed) || /^export\s/.test(trimmed)) {
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
