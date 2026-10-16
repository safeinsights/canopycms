import { getErrorMessage, sanitizeErrorMessage } from '../../utils/error'

/** Where in the editor an error was caught, for the log line and the copied details. */
export interface EditorErrorContext {
  /** `editor` for the crash screen, `field` for a field boundary, `rich-text` for MDXEditor. */
  boundary: 'editor' | 'field' | 'rich-text'
  /** The field's canopy path, for a field or rich-text boundary. */
  fieldPath?: string
  /** React's component stack, when React supplied one. */
  componentStack?: string
}

/**
 * The single point every error an editor boundary catches passes through. Logs it, because a
 * boundary must never hide a crash; an adopter-facing report hook belongs here too.
 */
export function reportEditorError(error: unknown, context: EditorErrorContext): void {
  const where = context.fieldPath ? `${context.boundary} ${context.fieldPath}` : context.boundary
  console.error(`[canopycms] editor error caught (${where})`, error, context.componentStack ?? '')
}

const MAX_DETAILS_LENGTH = 8000

/**
 * The text "Copy error details" puts on the clipboard. Sanitised, because an author pastes it
 * into a chat or a ticket: stack frames can name local paths, and a message can carry a token.
 */
export function formatErrorDetails(error: unknown, context: EditorErrorContext): string {
  const lines = [
    'CanopyCMS editor error',
    `Time: ${new Date().toISOString()}`,
    `Caught by: ${context.boundary}${context.fieldPath ? ` (${context.fieldPath})` : ''}`,
    `Error: ${error instanceof Error ? `${error.name}: ${error.message}` : getErrorMessage(error)}`,
  ]
  if (typeof navigator !== 'undefined') lines.push(`Browser: ${navigator.userAgent}`)
  if (error instanceof Error && error.stack) lines.push('', 'Stack:', error.stack)
  if (context.componentStack) lines.push('', 'Component stack:', context.componentStack.trim())
  const details = sanitizeErrorMessage(lines.join('\n'))
  return details.length > MAX_DETAILS_LENGTH
    ? `${details.slice(0, MAX_DETAILS_LENGTH)}\n[truncated]`
    : details
}
