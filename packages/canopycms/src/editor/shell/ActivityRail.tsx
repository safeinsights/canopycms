'use client'

import React, {
  forwardRef,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { ActionIcon, Box, Divider, Indicator, Stack, Tooltip, VisuallyHidden } from '@mantine/core'
import { useElementSize, useMergedRef } from '@mantine/hooks'
import { UnsavedMark } from '../components/UnsavedMark'

const ACTIVITY_RAIL_WIDTH = 44

const RAIL_ITEM_ATTR = 'data-rail-item'

export interface ActivityRailProps {
  /** Rail buttons from the top: the activities. */
  top: ReactNode
  /** Rail buttons pinned to the bottom, such as Settings. */
  bottom?: ReactNode
  /** The account control, a tab stop of its own: an adopter's component manages its own focus. */
  account?: ReactNode
}

/**
 * The left activity rail: one vertical toolbar whose `RailButton`s share a single Tab stop and move
 * with the arrow keys, Home and End, then the account control. Layout only; the buttons come in as
 * children.
 */
export function ActivityRail({ top, bottom, account }: ActivityRailProps) {
  const toolbarRef = useRef<HTMLDivElement>(null)
  const currentRef = useRef<string | null>(null)
  // Re-renders on a resize, so the check below runs again.
  const { ref: sizeRef } = useElementSize<HTMLDivElement>()
  const mergedToolbarRef = useMergedRef(toolbarRef, sizeRef)
  const [overflowing, setOverflowing] = useState(false)

  const items = () =>
    Array.from(toolbarRef.current?.querySelectorAll<HTMLElement>(`[${RAIL_ITEM_ATTR}]`) ?? [])

  // Set on the DOM after every render, so a button that mounts or goes takes or hands on the Tab
  // stop in the same commit; it falls back to the first button.
  const placeTabStop = () => {
    const all = items()
    const stop = all.find((item) => item.getAttribute(RAIL_ITEM_ATTR) === currentRef.current)
    for (const item of all) item.tabIndex = item === (stop ?? all[0]) ? 0 : -1
  }
  useLayoutEffect(placeTabStop)

  // Only a rail too short for its buttons scrolls: a scroll container clips sideways too, and at
  // full height nothing, such as a two-digit count badge, should be cut off.
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    if (toolbar) setOverflowing(toolbar.scrollHeight > toolbar.clientHeight)
  })

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = items()
    // A menu portalled from a button still bubbles here through React; only the buttons rove.
    const index = all.indexOf(event.target as HTMLElement)
    if (index < 0) return
    const next =
      event.key === 'ArrowDown'
        ? all[(index + 1) % all.length]
        : event.key === 'ArrowUp'
          ? all[(index - 1 + all.length) % all.length]
          : event.key === 'Home'
            ? all[0]
            : event.key === 'End'
              ? all[all.length - 1]
              : undefined
    if (!next) return
    event.preventDefault()
    next.focus()
  }

  return (
    <Stack
      gap={0}
      h="100%"
      w={ACTIVITY_RAIL_WIDTH}
      align="center"
      style={{
        borderInlineEnd: '1px solid var(--canopy-input-border)',
        background: 'var(--mantine-color-body)',
      }}
    >
      <Stack
        ref={mergedToolbarRef}
        role="toolbar"
        aria-orientation="vertical"
        aria-label="Activities"
        gap={6}
        py={8}
        align="center"
        style={{
          flex: 1,
          minHeight: 0,
          ...(overflowing && {
            alignSelf: 'stretch',
            overflowY: 'auto',
            overflowX: 'hidden',
            scrollbarWidth: 'none',
          }),
        }}
        onKeyDown={onKeyDown}
        onFocus={(event) => {
          const id = event.target.getAttribute(RAIL_ITEM_ATTR)
          if (id) {
            currentRef.current = id
            placeTabStop()
          }
        }}
      >
        {top}
        <div style={{ flex: 1 }} />
        {bottom}
      </Stack>
      {account && <Stack pb={8}>{account}</Stack>}
    </Stack>
  )
}

export interface RailButtonProps extends Omit<ComponentPropsWithoutRef<'button'>, 'children'> {
  /** Unique within the rail; the roving Tab stop is tracked by it. Not `id`: Mantine's
   * `Menu.Target` sets that on its child. */
  railId: string
  /** The accessible name and the tooltip's text. */
  label: string
  icon: ReactNode
  /** Highlights the button while its panel or drawer is open. */
  active?: boolean
  /** Shown after the label in the tooltip, as the platform writes it ("⌘P"). */
  shortcut?: string
  /** A count badge, hidden at zero; the label should say it too. */
  count?: number
  /** The unsaved dot at the button's corner; the label should say it too. */
  unsavedMark?: boolean
  countTestId?: string
  tooltipDisabled?: boolean
  /** Disables the button, which stays focusable, and its tooltip gives this reason instead. */
  disabledReason?: string
}

/** Sets the buttons after it apart. It carries no `data-rail-item`, so the arrow keys skip it. */
export function RailDivider() {
  return <Divider w={24} my={2} />
}

/** A rail button: icon only, named by `label`, which its tooltip repeats on hover and focus. */
export const RailButton = forwardRef<HTMLButtonElement, RailButtonProps>(function RailButton(
  {
    railId,
    label,
    icon,
    active = false,
    shortcut,
    count = 0,
    unsavedMark = false,
    countTestId,
    tooltipDisabled,
    disabledReason,
    onClick,
    ...rest
  },
  ref,
) {
  const reasonId = useId()
  const button = (
    <ActionIcon
      ref={ref}
      // Filled when active: a tint alone would show the state by colour, under 3:1.
      variant={active ? 'filled' : 'subtle'}
      color={active ? undefined : 'gray'}
      size="lg"
      radius="md"
      aria-label={label}
      {...rest}
      aria-disabled={disabledReason ? true : rest['aria-disabled']}
      aria-describedby={disabledReason ? reasonId : rest['aria-describedby']}
      data-disabled={disabledReason ? true : undefined}
      onClick={disabledReason ? undefined : onClick}
      {...{ [RAIL_ITEM_ATTR]: railId }}
    >
      {icon}
      {disabledReason && (
        <VisuallyHidden component="span" id={reasonId}>
          {disabledReason}
        </VisuallyHidden>
      )}
    </ActionIcon>
  )
  return (
    <Tooltip
      label={disabledReason ?? (shortcut ? `${label} (${shortcut})` : label)}
      position="right"
      disabled={tooltipDisabled}
    >
      {/* Always mounted, so a count arriving never remounts a focused button. */}
      <Indicator
        label={
          <span aria-hidden data-testid={countTestId}>
            {count}
          </span>
        }
        size={16}
        offset={4}
        withBorder
        disabled={count === 0}
        styles={{
          indicator: {
            pointerEvents: 'none',
            // Mantine paints the pill again in a ::before, from this variable.
            '--indicator-color': 'var(--canopy-count-bg)',
            '--indicator-text-color': 'var(--mantine-color-text)',
          },
        }}
      >
        {button}
        {unsavedMark && (
          <Box
            component="span"
            aria-hidden
            pos="absolute"
            top={5}
            right={5}
            style={{
              pointerEvents: 'none',
              lineHeight: 0,
              borderRadius: '50%',
              boxShadow: '0 0 0 2px var(--mantine-color-body)',
            }}
          >
            <UnsavedMark aria-hidden data-testid="rail-unsaved-mark" />
          </Box>
        )}
      </Indicator>
    </Tooltip>
  )
})
