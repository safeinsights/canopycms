import { defineCanopyConfig } from 'canopycms'

import { homeSchema, postSchema } from './app/schemas'

export default defineCanopyConfig({
  defaultBranchAccess: 'allow',
  mode: 'prod-sim',
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
  schema: {
    collections: [
      {
        name: 'posts',
        label: 'Posts',
        path: 'posts',
        entries: {
          format: 'json',
          fields: postSchema,
        },
      },
    ],
    singletons: [
      {
        name: 'home',
        label: 'Home',
        path: 'home',
        format: 'json',
        fields: homeSchema,
      },
    ],
  },
})
