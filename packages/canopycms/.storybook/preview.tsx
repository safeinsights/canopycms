import type { Preview } from '@storybook/react'
import { CanopyCMSProvider } from '../src/editor/theme'
import { ApiClientProvider, SWRProvider } from '../src/editor/context'

const preview: Preview = {
  decorators: [
    (Story) => (
      <CanopyCMSProvider>
        {/* MarkdownField's image dialog (and MediaLibrary/ImageField) read the
            API client via context DI, same as the real Editor - provide it
            here too so those stories don't crash in isolation. SWRProvider
            covers Editor's fetch-on-load hooks (useBranchManager etc.). */}
        <SWRProvider>
          <ApiClientProvider>
            <Story />
          </ApiClientProvider>
        </SWRProvider>
      </CanopyCMSProvider>
    ),
  ],
}

export default preview
