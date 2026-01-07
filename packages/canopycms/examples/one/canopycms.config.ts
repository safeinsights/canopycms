import { defineCanopyConfig } from 'canopycms'

import { homeSchema, postSchema } from './app/schemas'

export default defineCanopyConfig({
  defaultBranchAccess: 'allow',
  mode: 'local-prod-sim',
  sourceRoot: 'packages/canopycms/examples/one',
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
      type: 'entry',
      name: 'home',
      label: 'Home',
      path: 'home',
      format: 'json',
      fields: homeSchema,
    },
  ],
})
