/**
 * Focuses `target` unless the user has moved focus since `origin` had it. Focus that stayed on
 * `origin`, or fell to the body with an unmounted element, is the user's to get back; focus they
 * put somewhere else while a write was in flight stays where they put it.
 */
export const moveFocusIfUnmoved = (
  origin: Element | null,
  target: HTMLElement | null | undefined,
): void => {
  const active = document.activeElement
  if (!active || active === origin || active === document.body || !active.isConnected) {
    target?.focus()
  }
}
