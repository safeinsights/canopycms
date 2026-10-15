import type { Meta, StoryObj } from '@storybook/react'
import { Center, Text } from '@mantine/core'

import { EditorShell, type EditorShellProps } from './EditorShell'
import { PaneLayout, type PaneArrangement } from './PaneLayout'
import { BranchLockBanner } from '../components/BranchLockBanner'
import { EditorHeader, type EditorHeaderProps } from '../components/EditorHeader'
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
  unresolvedCommentCount: 0,
  comments: [],
  onNavigatorOpen: noop,
  onFileReload: noop,
  onFileDiscardDraft: noop,
  onEntrySelect: noop,
  onBranchReloadData: noop,
  onBranchDiscardDrafts: noop,
  onBranchManagerOpen: noop,
  onCommentsPanelOpen: noop,
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
  ...header
}: Partial<EditorHeaderProps> & { arrangement?: PaneArrangement }) => {
  const props = { ...headerProps, ...header }
  return (
    <EditorShell
      topBar={<EditorHeader {...props} />}
      banner={<BranchLockBanner {...props} />}
      main={
        <PaneLayout
          arrangement={arrangement}
          preview={<Placeholder name="Preview" />}
          form={<Placeholder name="Form" />}
        />
      }
      rail={
        <EditorSidebar
          layout={arrangement}
          highlightEnabled={false}
          onLayoutChange={noop}
          onHighlightToggle={noop}
          onMediaLibraryOpen={noop}
          onLogoutClick={noop}
        />
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
    rail: <Placeholder name="Rail" minWidth={64} />,
  } satisfies EditorShellProps,
}

export const Editing: Story = {
  render: () => <EditorChrome />,
}

export const Stacked: Story = {
  render: () => <EditorChrome arrangement="stacked" />,
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
