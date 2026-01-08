import { defineCanopyConfig } from 'canopycms'

import { homeSchema, postSchema, docSchema, authorSchema } from './app/schemas'

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
      type: 'collection',
      name: 'authors',
      label: 'Authors',
      path: 'authors',
      format: 'json',
      fields: authorSchema,
    },
    {
      type: 'collection',
      name: 'docs',
      label: 'Documentation',
      path: 'docs',
      format: 'json',
      fields: docSchema,
      children: [
        {
          type: 'collection',
          name: 'guides',
          label: 'Guides',
          path: 'guides',
          format: 'json',
          fields: docSchema,
        },
        {
          type: 'collection',
          name: 'api',
          label: 'API Reference',
          path: 'api',
          format: 'json',
          fields: docSchema,
          children: [
            {
              type: 'collection',
              name: 'v1',
              label: 'v1',
              path: 'v1',
              format: 'json',
              fields: docSchema,
            },
            {
              type: 'collection',
              name: 'v2',
              label: 'v2',
              path: 'v2',
              format: 'json',
              fields: docSchema,
            },
          ],
        },
      ],
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
