import { defineCanopyConfig } from 'canopycms'

export default defineCanopyConfig({
  defaultBranchAccess: 'deny',
  // Every dev user may read and edit, so a non-admin dev user can create and share branches:
  // creating one needs edit access to some path, and this demo's settings branch starts with
  // no permission rules. A production site keeps edit closed and grants it by rule; see
  // README.md's "Public read on server deployments".
  defaultPathAccess: { read: 'allow', edit: 'allow' },
  mode: 'dev',
  sourceRoot: 'apps/example1',
  gitBotAuthorName: 'CanopyCMS Example Bot',
  gitBotAuthorEmail: 'canopycms@example.com',
  editor: {
    // The editor previews through app/preview/[[...path]], which renders a branch on request.
    previewPrefix: '/preview',
    title: 'CanopyCMS Editor',
    theme: {
      colors: {
        brand: '#4f46e5',
        accent: '#0ea5e9',
        neutral: '#0f172a',
      },
    },
  },
})
