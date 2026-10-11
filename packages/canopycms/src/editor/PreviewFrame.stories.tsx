import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'

import { CANOPY_PREVIEW_MESSAGE, CANOPY_PREVIEW_READY } from './preview-bridge'
import { PreviewFrame } from './PreviewFrame'

const meta: Meta<typeof PreviewFrame> = {
  title: 'Editor/PreviewFrame',
  component: PreviewFrame,
  parameters: {
    layout: 'fullscreen',
  },
}

export default meta
type Story = StoryObj<typeof PreviewFrame>

const page = (script: string) => `<!doctype html>
<html><body style="font-family: system-ui, sans-serif; padding: 32px">
<h1 id="title">Saved title</h1>
<p>A stand-in preview page.</p>
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

const Frame = ({ script }: { script: string }) => {
  // A blob: URL carries this page's origin, so the frame treats it as a same-origin preview.
  const [src] = useState(() => URL.createObjectURL(new Blob([page(script)], { type: 'text/html' })))
  return (
    <PreviewFrame
      src={src}
      path="/x"
      data={{ title: 'Draft title from the form' }}
      style={{ width: '100%', height: '100vh' }}
    />
  )
}

/** The preview sends ready, so the bar clears and the draft shows. */
export const Connected: Story = {
  render: () => <Frame script={bridgeScript} />,
}

/** The preview never sends ready: the bar runs until 5s after load, then the chip replaces it. */
export const LiveUpdatesOff: Story = {
  render: () => <Frame script="" />,
}
