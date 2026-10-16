/**
 * @internal Exported for tests. Hides each separator that starts or ends a wrapped row; it keeps
 * its space, so hiding never moves the wrap. One not laid out (zero height) is left alone.
 */
export const hideSeparatorsAtWrap = (toolbar: HTMLElement): void => {
  for (const separator of toolbar.querySelectorAll<HTMLElement>('[role="separator"]')) {
    const own = separator.getBoundingClientRect()
    if (own.height === 0) continue
    const previous = separator.previousElementSibling?.getBoundingClientRect()
    const next = separator.nextElementSibling?.getBoundingClientRect()
    const atRowEdge = !previous || !next || previous.bottom <= own.top || next.top >= own.bottom
    separator.style.visibility = atRowEdge ? 'hidden' : ''
  }
}

/** Reruns `hideSeparatorsAtWrap` on `selector` in `root` as either resizes; returns cleanup. */
export const watchToolbarWrap = (root: HTMLElement, selector: string): (() => void) => {
  if (typeof ResizeObserver !== 'function') return () => {}
  let watched: HTMLElement | null = null
  const observer = new ResizeObserver(() => {
    const toolbar = root.querySelector<HTMLElement>(selector)
    if (!toolbar) return
    if (toolbar !== watched) {
      if (watched) observer.unobserve(watched)
      watched = toolbar
      observer.observe(toolbar)
    }
    hideSeparatorsAtWrap(toolbar)
  })
  observer.observe(root)
  return () => observer.disconnect()
}
