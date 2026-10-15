import { ActionIcon, Indicator, Paper, Stack, Tooltip } from '@mantine/core'
import { IconLayoutColumns, IconLayoutRows, IconMarquee } from '@tabler/icons-react'
import type { PaneArrangement } from '../shell/PaneLayout'
import type { InexactMark } from '../preview-marks'

export interface EditorSidebarProps {
  /**
   * Current layout mode (side or stacked).
   */
  layout: PaneArrangement

  /**
   * Whether field highlighting is enabled.
   */
  highlightEnabled: boolean

  /** The preview reported marking no elements; unknown (an older bridge) is false. */
  previewMarksNothing?: boolean

  /** The preview's marks that name no field of the entry; see `findInexactMarks`. */
  previewInexactMarks?: readonly InexactMark[]

  /**
   * Callback when layout changes.
   */
  onLayoutChange: (layout: PaneArrangement) => void

  /**
   * Callback when highlight toggle is clicked.
   */
  onHighlightToggle: () => void
}

const inexactMarksNote = (marks: readonly InexactMark[]): string => {
  const shown = marks.slice(0, 3).map((mark) => mark.path || '""')
  const more = marks.length > shown.length ? `, and ${marks.length - shown.length} more` : ''
  const noun = marks.length === 1 ? "mark doesn't" : "marks don't"
  return `${marks.length} preview ${noun} match a field: ${shown.join(', ')}${more}. The browser console names the nearest field of each.`
}

/** The preview tools beside the panes: the layout toggle and the highlight toggle. */
export function EditorSidebar({
  layout,
  highlightEnabled,
  previewMarksNothing = false,
  previewInexactMarks = [],
  onLayoutChange,
  onHighlightToggle,
}: EditorSidebarProps) {
  return (
    <Paper
      component="aside"
      aria-label="Preview tools"
      radius={0}
      style={{
        height: '100%',
        width: 44,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '8px 0',
        borderInlineStart: '1px solid var(--canopy-input-border)',
      }}
    >
      <Stack gap="sm" align="center">
        <Tooltip label="Toggle layout" position="left">
          <ActionIcon
            variant="subtle"
            size="lg"
            radius="md"
            aria-label="Toggle layout"
            onClick={() => onLayoutChange(layout === 'side' ? 'stacked' : 'side')}
          >
            {layout === 'side' ? <IconLayoutRows size={18} /> : <IconLayoutColumns size={18} />}
          </ActionIcon>
        </Tooltip>

        <Tooltip
          label={
            previewMarksNothing
              ? "This preview page marks no editable elements, so nothing can be highlighted or clicked to focus. The site's developer can mark them with fieldProps."
              : inexactMarksNote(previewInexactMarks)
          }
          opened={
            !highlightEnabled
              ? false
              : previewMarksNothing
                ? true
                : previewInexactMarks.length > 0
                  ? undefined
                  : false
          }
          position="left"
          multiline
          w={240}
          withArrow
        >
          <Indicator
            label={previewInexactMarks.length}
            size={16}
            withBorder
            disabled={!highlightEnabled || previewInexactMarks.length === 0}
            styles={{
              indicator: {
                '--indicator-color': 'var(--canopy-count-bg-orange)',
                '--indicator-text-color': 'var(--mantine-color-text)',
              },
            }}
          >
            <ActionIcon
              variant={highlightEnabled ? 'filled' : 'subtle'}
              color={highlightEnabled ? 'brand' : 'gray'}
              size="lg"
              radius="md"
              aria-pressed={highlightEnabled}
              aria-label="Toggle highlights"
              data-testid="toggle-highlights-button"
              aria-description={
                highlightEnabled && previewInexactMarks.length > 0
                  ? inexactMarksNote(previewInexactMarks)
                  : undefined
              }
              onClick={onHighlightToggle}
            >
              <IconMarquee size={18} />
            </ActionIcon>
          </Indicator>
        </Tooltip>
      </Stack>
    </Paper>
  )
}
