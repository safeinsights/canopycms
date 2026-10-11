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
const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

/**
 * Scrolls a field's element into view and focuses what a person would type into: the element
 * itself when it is an input, else its first input, else its first other focusable control
 * that is not a comment control, else the element when it takes programmatic focus.
 */
export const focusFieldTarget = (element: HTMLElement): void => {
  element.scrollIntoView({ behavior: 'smooth', block: 'center' })
  const focusable = element.matches(EDITABLE)
    ? element
    : (element.querySelector<HTMLElement>(EDITABLE) ??
      [...element.querySelectorAll<HTMLElement>(FOCUSABLE)].find(
        (el) => !el.closest('[data-comment-control]'),
      ) ??
      (element.hasAttribute('tabindex') ? element : null))
  focusable?.focus({ preventScroll: true })
}
