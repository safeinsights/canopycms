import { defineCanopyConfig } from 'canopycms'

import { homeSchema, postSchema } from './app/schemas'

export default defineCanopyConfig({
  defaultBranchAccess: 'allow',
  mode: 'local-prod-sim',
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
  schema: [
    {
      type: 'collection',
      name: 'posts',
      label: 'Posts',
      path: 'posts',
      format: 'json',
      fields: postSchema,
    },
    {
      type: 'singleton',
      name: 'home',
      label: 'Home',
      path: 'home',
      format: 'json',
      fields: homeSchema,
    },
  ],
})
