import { formatCanopyPath, parseCanopyPath } from './canopy-path'

/**
 * The form element for a path, as given or as `canopy-path.ts` spells it (`blocks.2.title` is
 * `blocks[2].title`), else for its nearest ancestor that has one: a list item (`tags[1]`) has no
 * field of its own. Compares values, not a selector: the path is untrusted.
 */
export const findFieldTarget = (
  path: string,
  root: ParentNode = document,
): { element: HTMLElement; path: string } | undefined => {
  const byField = new Map<string, HTMLElement>()
  for (const element of root.querySelectorAll<HTMLElement>('[data-canopy-field]')) {
    const field = element.getAttribute('data-canopy-field')
    if (field && !byField.has(field)) byField.set(field, element)
  }
  const exact = byField.get(path)
  if (exact) return { element: exact, path }
  const segments = parseCanopyPath(path)
  for (let length = segments.length; length > 0; length--) {
    const candidate = formatCanopyPath(segments.slice(0, length))
    const element = byField.get(candidate)
    if (element) return { element, path: candidate }
  }
  return undefined
}

/** Dispatched from a form element to open every collapsed list row holding it (`ItemList`). */
export const REVEAL_FIELD_EVENT = 'canopy:reveal-field'

/**
 * Asks every collapsed row holding `element` to open. True when one was closed: its content shows
 * once React re-renders, so act on the element through `whenRevealed`.
 */
export const revealField = (element: HTMLElement): boolean =>
  !element.dispatchEvent(new CustomEvent(REVEAL_FIELD_EVENT, { bubbles: true, cancelable: true }))

const MAX_REVEAL_FRAMES = 10

/** Runs `then` once `element` is shown: at once, or a few frames on when a row had to open. */
export const whenRevealed = (element: HTMLElement, then: () => void): void => {
  if (!revealField(element)) {
    then()
    return
  }
  let frames = 0
  const check = () => {
    frames += 1
    const shown = typeof element.checkVisibility !== 'function' || element.checkVisibility()
    if (shown || frames >= MAX_REVEAL_FRAMES) then()
    else requestAnimationFrame(check)
  }
  requestAnimationFrame(check)
}

const EDITABLE = 'input:not([type="hidden"]), textarea, select, [contenteditable="true"]'
const FOCUSABLE = 'button, [href], [tabindex]'

/** Takes keyboard focus as it stands: enabled, in the tab order, and rendered. */
const canTakeFocus = (el: HTMLElement): boolean =>
  !el.matches(':disabled, [tabindex="-1"]') &&
  (typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true }))

/**
 * Scrolls a field's element into view and focuses what a person would type into: the element
 * itself when it is an input, else its first focusable input, else its first other focusable
 * control that is not a comment control, else the element when it takes programmatic focus.
 * An input out of the tab order or not rendered, such as a dropzone's file input, is never chosen.
 * Collapsed list rows holding the element open first.
 */
export const focusFieldTarget = (element: HTMLElement): void =>
  whenRevealed(element, () => focusShownField(element))

const focusShownField = (element: HTMLElement): void => {
  element.scrollIntoView({ behavior: 'smooth', block: 'center' })
  const inputs = [element, ...element.querySelectorAll<HTMLElement>(EDITABLE)].filter(
    (el) => el.matches(EDITABLE) && canTakeFocus(el),
  )
  const controls = [...element.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => canTakeFocus(el) && !el.closest('[data-comment-control]'),
  )
  const focusable =
    inputs[0] ?? controls[0] ?? (element.hasAttribute('tabindex') ? element : undefined)
  focusable?.focus({ preventScroll: true })
}
