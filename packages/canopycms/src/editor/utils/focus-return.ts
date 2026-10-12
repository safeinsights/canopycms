import { useRef, type MouseEvent, type RefObject } from 'react'

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

/**
 * Run by `useMenuItemFocusReturn` when its menu has closed after an item acted: focuses the menu's
 * `target` trigger once the item has unmounted and dropped focus to the page. Mantine calls it just before
 * unmounting the items, hence the frame's wait; `returnFocus` would instead steal focus from an
 * overlay the item opened, which holds it by then.
 * @internal Exported for tests.
 */
export function focusIfDropped(target: HTMLElement | null): void {
  requestAnimationFrame(() => {
    const active = document.activeElement
    if (!active || active === document.body) target?.focus({ preventScroll: true })
  })
}

/**
 * Props for a Mantine `Menu` and its `Menu.Dropdown` that run `focusIfDropped` on `trigger` after an
 * item acted. A menu dismissed by a press elsewhere keeps focus where that press left it.
 */
export function useMenuItemFocusReturn(trigger: RefObject<HTMLElement | null>) {
  const acted = useRef(false)
  return {
    menu: {
      onExitTransitionEnd: () => {
        if (acted.current) focusIfDropped(trigger.current)
        acted.current = false
      },
    },
    dropdown: {
      onClickCapture: (event: MouseEvent) => {
        if (
          event.target instanceof Element &&
          event.target.closest('[role="menuitem"]:not([aria-disabled="true"])')
        ) {
          acted.current = true
        }
      },
    },
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
