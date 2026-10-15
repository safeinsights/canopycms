import type { Meta, StoryObj } from '@storybook/react'
import { type ReactNode, useState } from 'react'

import { Alert } from '@mantine/core'

import type { PreviewWidth } from './hooks/useEditorLayout'
import { CANOPY_PREVIEW_MESSAGE, CANOPY_PREVIEW_READY } from './preview-bridge'
import type { InexactMark } from './preview-marks'
import { PreviewPane } from './PreviewPane'

const meta: Meta<typeof PreviewPane> = {
  title: 'Editor/PreviewPane',
  component: PreviewPane,
  parameters: {
    layout: 'fullscreen',
  },
}

export default meta
type Story = StoryObj<typeof PreviewPane>

// A stand-in site page whose layout changes at real breakpoints, so each width shows its own.
const page = (script: string) => `<!doctype html>
<html><head><style>
body { margin: 0; font-family: system-ui, sans-serif; background: #fff; color: #111; }
main { padding: 24px; display: grid; gap: 16px; grid-template-columns: 1fr; }
.card { border: 1px solid #ccc; border-radius: 8px; padding: 16px; }
.bp::after { content: 'Mobile layout'; }
@media (min-width: 640px) { main { grid-template-columns: 1fr 1fr; } .bp::after { content: 'Tablet layout'; } }
@media (min-width: 1024px) { main { grid-template-columns: 1fr 1fr 1fr; } .bp::after { content: 'Desktop layout'; } }
</style></head><body>
<main>
  <h1 id="title" style="grid-column: 1 / -1">Saved title</h1>
  <p class="card bp" style="grid-column: 1 / -1"></p>
  <div class="card">One</div><div class="card">Two</div><div class="card">Three</div>
</main>
${script}
</body></html>`

// The handshake `usePreviewData` performs, inlined: say ready, then render each draft.
const bridgeScript = `<script>
window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.data?.type !== '${CANOPY_PREVIEW_MESSAGE}') return
  document.getElementById('title').textContent = event.data.data.title
})
window.parent.postMessage({ type: '${CANOPY_PREVIEW_READY}', path: '/x' }, location.origin)
</script>`

const Pane = ({
  initialWidth,
  script = bridgeScript,
  paneWidth = '100%',
  path = '/posts/hello?branch=feature-a',
  notice,
  onPreviewError,
  tools = false,
  initialHighlight = false,
  marksNothing,
  inexactMarks,
  showMarkDiagnostics,
  initialMaximized = false,
  resizing,
}: {
  initialWidth: PreviewWidth
  script?: string
  paneWidth?: string | number
  path?: string
  notice?: ReactNode
  onPreviewError?: (error: { message: string } | null) => void
  /** Shows the highlight and maximize controls the editor passes. */
  tools?: boolean
  initialHighlight?: boolean
  marksNothing?: boolean
  inexactMarks?: readonly InexactMark[]
  showMarkDiagnostics?: boolean
  initialMaximized?: boolean
  resizing?: boolean
}) => {
  // A blob: URL carries this page's origin, so the frame treats it as a same-origin preview.
  const [src] = useState(() => URL.createObjectURL(new Blob([page(script)], { type: 'text/html' })))
  const [previewWidth, setPreviewWidth] = useState(initialWidth)
  const [highlight, setHighlight] = useState(initialHighlight)
  const [maximized, setMaximized] = useState(initialMaximized)
  const toolProps = tools
    ? {
        highlightEnabled: highlight,
        onHighlightToggle: () => setHighlight((on) => !on),
        marksNothing,
        inexactMarks,
        showMarkDiagnostics,
        layout: 'side' as const,
        maximized,
        onMaximizedChange: setMaximized,
        resizing,
      }
    : {}
  return (
    <div style={{ width: paneWidth, height: '100vh' }}>
      <PreviewPane
        src={src}
        path={path}
        notice={notice}
        onPreviewError={onPreviewError}
        data={{ title: 'Draft title from the form' }}
        previewWidth={previewWidth}
        onPreviewWidthChange={setPreviewWidth}
        {...toolProps}
      />
    </div>
  )
}

/** The iframe fills the pane, as before the toolbar existed. */
export const Fit: Story = { render: () => <Pane initialWidth="fit" /> }

/** 1280 px, scaled down whenever the pane is narrower. */
export const Desktop: Story = { render: () => <Pane initialWidth="desktop" /> }

/** 768 px, centred in a wider pane. */
export const Tablet: Story = { render: () => <Pane initialWidth="tablet" /> }

/** 390 px, centred in a wider pane. */
export const Mobile: Story = { render: () => <Pane initialWidth="mobile" /> }

/** A 360 px pane: the toolbar wraps and Desktop scales to fit. */
export const NarrowPane: Story = { render: () => <Pane initialWidth="desktop" paneWidth={360} /> }

/** The preview never sends ready: 5s after load the chip appears; its Retry is the toolbar's reload. */
export const LiveUpdatesOff: Story = { render: () => <Pane initialWidth="fit" script="" /> }

/** A long path truncates; its full text is in the Copy path tooltip. */
export const LongPathNarrowPane: Story = {
  render: () => (
    <Pane
      initialWidth="mobile"
      paneWidth={360}
      path="/docs/getting-started/installing-the-command-line-tools-on-every-platform?branch=feature-a"
    />
  ),
}

/** A preview error sits between the toolbar and the page, never over it; Close and Reload clear it. */
const PaneWithNotice = () => {
  const [error, setError] = useState<string | null>(
    'Page sections › Hero › Heading: Unexpected closing tag',
  )
  return (
    <Pane
      initialWidth="desktop"
      onPreviewError={(next) => setError(next?.message ?? null)}
      notice={
        error && (
          <Alert
            color="red"
            title="Preview error"
            withCloseButton
            onClose={() => setError(null)}
            radius={0}
          >
            {error}
          </Alert>
        )
      }
    />
  )
}

export const WithNotice: Story = { render: () => <PaneWithNotice /> }

const unmapped: InexactMark[] = [
  { path: 'hero.subtitle', nearest: 'hero' },
  { path: 'cta.label' },
  { path: 'blocks[2].body', nearest: 'blocks[2]' },
  { path: 'footer' },
]

/** The editor's controls: highlight and maximize, as an editor sees them. */
export const WithTools: Story = { render: () => <Pane initialWidth="fit" tools /> }

/** An admin with highlights on sees how many marks name no field; the chip explains them. */
export const UnmappedMarksAdmin: Story = {
  render: () => (
    <Pane initialWidth="fit" tools initialHighlight inexactMarks={unmapped} showMarkDiagnostics />
  ),
}

/** The same page for an editor: no diagnostics. */
export const UnmappedMarksEditor: Story = {
  render: () => <Pane initialWidth="fit" tools initialHighlight inexactMarks={unmapped} />,
}

/** Highlights on, and the page marks nothing: the toolbar says so. */
export const NothingToHighlight: Story = {
  render: () => <Pane initialWidth="fit" tools initialHighlight marksNothing />,
}

/** Maximized: a labelled Restore; Esc restores. */
export const Maximized: Story = { render: () => <Pane initialWidth="fit" tools initialMaximized /> }

/** The readout a divider drag shows over the preview. */
export const Resizing: Story = { render: () => <Pane initialWidth="fit" tools resizing /> }

/** Every control in a 360 px pane: the toolbar wraps in units. */
export const WithToolsNarrowPane: Story = {
  render: () => (
    <Pane
      initialWidth="fit"
      paneWidth={360}
      tools
      initialHighlight
      inexactMarks={unmapped}
      showMarkDiagnostics
    />
  ),
}
