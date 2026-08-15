import { defineCanopyConfig } from 'canopycms'

export default defineCanopyConfig({
  defaultBranchAccess: 'deny',
  // Public read without opening edit/review -- the posture README.md's "Public read on
  // server deployments" section recommends. Without this, a non-admin visitor (including
  // the dev-auth default user) gets "Forbidden: path access denied" on every route, since
  // `defaultPathAccess` otherwise falls back to fully closed ('deny' on every level).
  defaultPathAccess: { read: 'allow' },
  mode: 'dev',
  sourceRoot: 'apps/example1',
  gitBotAuthorName: 'CanopyCMS Example Bot',
  gitBotAuthorEmail: 'canopycms@example.com',
  editor: {
    title: 'CanopyCMS Editor',
    subtitle: 'Edit entries with live preview',
    theme: {
      colors: {
        brand: '#4f46e5',
        accent: '#0ea5e9',
        neutral: '#0f172a',
      },
    },
  },
})
