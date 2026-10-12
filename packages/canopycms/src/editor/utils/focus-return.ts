/**
 * Mantine's own `returnFocus` records the focused element at open, and a menu item has unmounted
 * with its menu by close, so an overlay opened from one returns focus here instead.
 * `FOCUS_RETURN_ATTR` marks an overlay whose exit callback does; `focusIfIdle` treats focus inside it as idle.
 */
export const FOCUS_RETURN_ATTR = 'data-focus-return'

/**
 * Focuses `target` unless the user has moved focus on: nothing is focused, or focus is inside an
 * overlay `FOCUS_RETURN_ATTR` marks, as a closing one is until after its exit callback.
 */
export function focusIfIdle(target: HTMLElement | null): void {
  const active = document.activeElement
  if (!active || active === document.body || active.closest(`[${FOCUS_RETURN_ATTR}]`)) {
    target?.focus({ preventScroll: true })
  }
}

/** The focused control to hand focus back to, or null when it is a menu item (gone once it acts) or the page. */
export function rememberOpener(): HTMLElement | null {
  const active = document.activeElement
  return active instanceof HTMLElement &&
    active !== document.body &&
    !active.closest('[role="menuitem"]')
    ? active
    : null
}

/** The remembered opener while it is still on the page, else the menu trigger that stands in for it. */
export function returnTarget(
  opener: HTMLElement | null,
  standIn: () => HTMLElement | null,
): HTMLElement | null {
  return opener?.isConnected ? opener : standIn()
}

/**
 * Props that make a Mantine `Modal`, `Drawer` or `modals.openConfirmModal` focus `returnFocusTo()`
 * once it has closed; none, keeping Mantine's default, without one.
 */
export function focusReturnProps(returnFocusTo?: () => HTMLElement | null): {
  returnFocus?: false
  onExitTransitionEnd?: () => void
  [FOCUS_RETURN_ATTR]?: true
} {
  if (!returnFocusTo) return {}
  return {
    returnFocus: false,
    onExitTransitionEnd: () => focusIfIdle(returnFocusTo()),
    [FOCUS_RETURN_ATTR]: true,
  }
}
