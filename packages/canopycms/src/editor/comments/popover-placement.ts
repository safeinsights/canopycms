/** The two places a field's comment popover may open, neither over the field's input. */
export interface FieldAnchors {
  /** At the top of the field, above its label row. */
  above: HTMLElement | null
  /** At the bottom of the field, below its input. */
  below: HTMLElement | null
}

export type PopoverSide = 'above' | 'below'

/** Room the popover needs on its side, for its heading and a composer. */
const POPOVER_ROOM = 280

const scrollBounds = (el: HTMLElement): { top: number; bottom: number } => {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) {
      const { top, bottom } = p.getBoundingClientRect()
      return { top, bottom }
    }
  }
  return { top: 0, bottom: window.innerHeight }
}

/**
 * Picks the side a field's popover opens on. A short field prefers below its input; a group or a
 * field taller than 40% of its scroll area prefers above its label row, since below is far from
 * the control. Either takes the other side when only that one has room. When neither does, or
 * when `scroll` asks, the preferred side scrolls to the middle first. Room is measured in the
 * field's scroll container.
 */
export const choosePopoverSide = (
  { above, below }: FieldAnchors,
  { scroll = false }: { scroll?: boolean } = {},
): PopoverSide => {
  if (!above || !below) return 'below'
  const measure = () => {
    const bounds = scrollBounds(above)
    const top = above.getBoundingClientRect().top
    const bottom = below.getBoundingClientRect().bottom
    const topInView = top >= bounds.top && top < bounds.bottom
    return {
      tall: bottom - top > (bounds.bottom - bounds.top) * 0.4,
      above: topInView && top - bounds.top >= POPOVER_ROOM,
      below: topInView && bottom <= bounds.bottom && bounds.bottom - bottom >= POPOVER_ROOM,
      roomAbove: top - bounds.top,
      roomBelow: bounds.bottom - bottom,
    }
  }
  const group = below.parentElement?.querySelector('[data-field-comments]') != null
  let room = measure()
  const preferred: PopoverSide = group || room.tall ? 'above' : 'below'
  const other: PopoverSide = preferred === 'above' ? 'below' : 'above'
  if (!scroll) {
    if (room[preferred]) return preferred
    if (room[other]) return other
  }
  // Instant, so the second measure reads the new geometry even under `scroll-behavior: smooth`.
  ;(preferred === 'above' ? above : below).scrollIntoView?.({
    block: 'center',
    behavior: 'instant',
  })
  room = measure()
  if (room[preferred]) return preferred
  if (room[other]) return other
  return room.roomBelow >= room.roomAbove ? 'below' : 'above'
}
