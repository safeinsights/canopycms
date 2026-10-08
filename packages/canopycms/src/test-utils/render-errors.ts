/**
 * For a jsdom test that expects an error boundary to catch. React's development build
 * re-raises each caught render error as a window `error` event, and jsdom writes an
 * unhandled one straight to stderr, where no console spy reaches it. Marking the event
 * handled stops that report; the boundary still sees the error. Returns the undo.
 */
export function silenceReportedRenderErrors(): () => void {
  const handle = (event: ErrorEvent) => event.preventDefault()
  window.addEventListener('error', handle)
  return () => window.removeEventListener('error', handle)
}
