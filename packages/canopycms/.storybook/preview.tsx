import type { Preview } from '@storybook/react'
import { CanopyCMSProvider } from '../src/editor/theme'
import { ApiClientProvider, SWRProvider } from '../src/editor/context'

const preview: Preview = {
  // The toolbar's colour scheme, or `&globals=colorScheme:dark` in a story's URL.
  globalTypes: {
    colorScheme: {
      description: 'Editor colour scheme',
      toolbar: { title: 'Scheme', icon: 'mirror', items: ['light', 'dark'], dynamicTitle: true },
    },
  },
  initialGlobals: { colorScheme: 'light' },
  decorators: [
    (Story, context) => (
      // Keyed, since the provider reads its scheme only when it mounts.
      <CanopyCMSProvider
        key={context.globals.colorScheme}
        colorScheme={context.globals.colorScheme === 'dark' ? 'dark' : 'light'}
      >
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
