import { withCanopy } from 'canopycms-next/config'

export default withCanopy({
  reactStrictMode: true,
  // The editor's toasts stack in the bottom-left corner, where Next's dev badge sits by default.
  devIndicators: { position: 'bottom-right' },
})
