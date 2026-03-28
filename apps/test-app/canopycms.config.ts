import { defineCanopyConfig } from 'canopycms'

export default defineCanopyConfig({
  defaultBranchAccess: 'allow',
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
  },
})
