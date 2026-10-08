/**
 * Markdown the rich-text editor failed to open this page session, keyed by text because the
 * text is what fails, with the reason to show. Memory only: a reload tries rich text again.
 */
const failures = new Map<string, string>()

const MAX_REMEMBERED = 20

export function rememberRichTextFailure(markdown: string, reason: string): void {
  failures.delete(markdown)
  failures.set(markdown, reason)
  if (failures.size > MAX_REMEMBERED) {
    const oldest = failures.keys().next()
    if (!oldest.done) failures.delete(oldest.value)
  }
}

export function recallRichTextFailure(markdown: string): string | undefined {
  return failures.get(markdown)
}

export function forgetRichTextFailure(markdown: string): void {
  failures.delete(markdown)
}

/** @internal Exported for tests. */
export function resetRichTextFailures(): void {
  failures.clear()
}
