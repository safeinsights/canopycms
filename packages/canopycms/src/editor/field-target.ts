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
 */
export const focusFieldTarget = (element: HTMLElement): void => {
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
