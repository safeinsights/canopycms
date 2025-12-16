import type { Preview } from '@storybook/react'
import { CanopyCMSProvider } from '../src/editor/theme'

const preview: Preview = {
  decorators: [
    (Story) => (
      <CanopyCMSProvider>
        <Story />
      </CanopyCMSProvider>
    ),
  ],
}

export default preview
