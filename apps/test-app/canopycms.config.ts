import { defineCanopyConfig } from 'canopycms'

export default defineCanopyConfig({
  defaultBranchAccess: 'deny',
  defaultPathAccess: 'allow',
  mode: 'dev',
  sourceRoot: 'apps/test-app',
  gitBotAuthorName: 'CanopyCMS Test Bot',
  gitBotAuthorEmail: 'test@example.com',
  editor: {
    title: 'Test Editor',
    subtitle: 'For E2E testing',
    theme: {
      colors: {
        brand: '#4f46e5',
        accent: '#0ea5e9',
        neutral: '#0f172a',
      },
    },
    // `app/page.tsx` serves the home singleton at `/` through `useCanopyPreview`; posts preview on
    // the `createPreviewPage` route; settings has no page.
    previewBase: {
      'content/home': '/',
      'content/posts': '/preview/posts',
      'content/settings': false,
    },
  },
})
