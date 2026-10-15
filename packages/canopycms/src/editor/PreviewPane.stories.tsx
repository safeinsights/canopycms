import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import type { PreviewWidth } from './hooks/useEditorLayout'
import { CANOPY_PREVIEW_MESSAGE, CANOPY_PREVIEW_READY } from './preview-bridge'
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
}: {
  initialWidth: PreviewWidth
  script?: string
  paneWidth?: string | number
}) => {
  // A blob: URL carries this page's origin, so the frame treats it as a same-origin preview.
  const [src] = useState(() => URL.createObjectURL(new Blob([page(script)], { type: 'text/html' })))
  const [previewWidth, setPreviewWidth] = useState(initialWidth)
  return (
    <div style={{ width: paneWidth, height: '100vh' }}>
      <PreviewPane
        src={src}
        path="/posts/hello?branch=feature-a"
        data={{ title: 'Draft title from the form' }}
        previewWidth={previewWidth}
        onPreviewWidthChange={setPreviewWidth}
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

/** A 360 px pane: the path truncates and Desktop scales to fit. */
export const NarrowPane: Story = { render: () => <Pane initialWidth="desktop" paneWidth={360} /> }

/** The preview never sends ready: 5s after load the chip appears; its Retry is the toolbar's reload. */
export const LiveUpdatesOff: Story = { render: () => <Pane initialWidth="fit" script="" /> }
