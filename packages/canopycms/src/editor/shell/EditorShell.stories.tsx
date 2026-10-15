import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { Box, Center, Stack, Text } from '@mantine/core'

import { EditorShell, type EditorShellProps } from './EditorShell'
import { PaneLayout, type PaneArrangement } from './PaneLayout'
import { SidePanelHost, type SidePanelHostProps } from './SidePanelHost'
import { BranchLockBanner } from '../components/BranchLockBanner'
import { EditorHeader, type EditorHeaderProps } from '../components/EditorHeader'
import { EditorRail } from '../components/EditorRail'
import { EditorSidebar } from '../components/EditorSidebar'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../../paths/test-utils'

const noop = () => {}

const Placeholder = ({ name, minWidth }: { name: string; minWidth?: number }) => (
  <Center
    h="100%"
    p="sm"
    miw={minWidth}
    style={{ border: '1px dashed var(--mantine-color-default-border)' }}
  >
    <Text size="sm" c="dimmed">
      {name}
    </Text>
  </Center>
)

const headerProps: EditorHeaderProps = {
  siteTitle: 'Example Site',
  headerTitle: 'Hello',
  currentEntry: {
    path: unsafeAsLogicalPath('posts/hello'),
    contentId: unsafeAsContentId('abc123def456'),
    label: 'Hello',
    schema: [],
  },
  branchName: 'feature/landing',
  operatingMode: 'prod',
  busy: false,
  breadcrumbSegments: ['Posts', 'Hello'],
  editedFiles: [],
  modifiedCount: 0,
  onNavigatorOpen: noop,
  onFileReload: noop,
  onFileDiscardDraft: noop,
  onEntrySelect: noop,
  onBranchReloadData: noop,
  onBranchDiscardDrafts: noop,
  onBranchManagerOpen: noop,
  onSave: noop,
  onSubmit: noop,
  onWithdraw: noop,
  hasUnsavedChanges: false,
  branchStatus: 'editing',
  branchIsProtected: false,
}

/** The editor's own chrome in the shell, as `Editor.tsx` composes it, around stand-in panes. */
const EditorChrome = ({
  arrangement = 'side',
  panelMode,
  ...header
}: Partial<EditorHeaderProps> & {
  arrangement?: PaneArrangement
  panelMode?: SidePanelHostProps['mode']
}) => {
  const props = { ...headerProps, ...header }
  const [panelOpen, setPanelOpen] = useState(panelMode !== undefined)
  const [panelWidth, setPanelWidth] = useState(280)
  const mode = panelMode ?? 'docked'
  const panel = (
    <SidePanelHost
      id="story-content-panel"
      title="Content"
      mode={mode}
      opened={panelOpen}
      width={panelWidth}
      minWidth={240}
      maxWidth={400}
      onWidthChange={setPanelWidth}
      onClose={() => setPanelOpen(false)}
    >
      <Stack gap={4} p="md">
        {['Home', 'About us', 'Posts', 'Hello', 'Second post'].map((label) => (
          <Text key={label} size="sm">
            {label}
          </Text>
        ))}
      </Stack>
    </SidePanelHost>
  )
  return (
    <EditorShell
      topBar={<EditorHeader {...props} />}
      banner={<BranchLockBanner {...props} />}
      rail={
        <EditorRail
          siteTitle={props.siteTitle}
          onHomeOpen={noop}
          contentPanelOpen={panelOpen}
          contentPanelId="story-content-panel"
          onContentToggle={() => setPanelOpen((open) => !open)}
          onQuickOpen={noop}
          quickOpenShortcut="⌘P"
          branchesOpen={false}
          onBranchesOpen={noop}
          onCommentsOpen={noop}
          commentsOpen={false}
          unresolvedCommentCount={2}
          mediaLibraryOpen={false}
          onMediaLibraryOpen={noop}
          onLogoutClick={noop}
        />
      }
      panel={mode === 'docked' ? panel : undefined}
      main={
        <Box display="flex" h="100%">
          <Box style={{ flex: 1, minWidth: 0 }}>
            <PaneLayout
              arrangement={arrangement}
              preview={<Placeholder name="Preview" />}
              form={<Placeholder name="Form" />}
              formOverlay={mode === 'overlay' ? panel : undefined}
            />
          </Box>
          <EditorSidebar
            layout={arrangement}
            highlightEnabled={false}
            onLayoutChange={noop}
            onHighlightToggle={noop}
          />
        </Box>
      }
    />
  )
}

const meta: Meta<typeof EditorShell> = {
  title: 'Editor/Shell/EditorShell',
  component: EditorShell,
  parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj<typeof EditorShell>

/** Each region outlined. The panel region is empty until something docks there. */
export const Regions: Story = {
  args: {
    topBar: <Placeholder name="Top bar" />,
    banner: <Placeholder name="Banner" />,
    panel: <Placeholder name="Panel" minWidth={240} />,
    main: <Placeholder name="Main" />,
    rail: <Placeholder name="Rail" minWidth={44} />,
  } satisfies EditorShellProps,
}

export const Editing: Story = {
  render: () => <EditorChrome />,
}

export const Stacked: Story = {
  render: () => <EditorChrome arrangement="stacked" />,
}

/** The content panel docked beside the panes, resizable from its edge. */
export const ContentPanelDocked: Story = {
  render: () => <EditorChrome panelMode="docked" />,
}

/** Stacked, the content panel lays over the form only, so the preview stays in view. */
export const ContentPanelOverlay: Story = {
  render: () => <EditorChrome arrangement="stacked" panelMode="overlay" />,
}

/** At phone width the panel is an overlay too. */
export const ContentPanelNarrow: Story = {
  parameters: {
    viewport: {
      viewports: { phone: { name: 'Phone', styles: { width: '390px', height: '844px' } } },
      defaultViewport: 'phone',
    },
  },
  render: () => <EditorChrome arrangement="stacked" panelMode="overlay" />,
}

export const InReview: Story = {
  render: () => <EditorChrome branchStatus="submitted" branchWriteBlocked />,
}

export const ProtectedBaseBranch: Story = {
  render: () => (
    <EditorChrome
      branchName="main"
      branchIsProtected
      branchReadOnly
      branchWriteBlocked
      branchStatus="editing"
    />
  ),
}
