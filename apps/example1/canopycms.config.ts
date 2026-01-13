import { defineCanopyConfig } from 'canopycms'

import { homeSchema, postSchema, docSchema, authorSchema } from './app/schemas'

export default defineCanopyConfig({
  defaultBranchAccess: 'allow',
  mode: 'prod-sim',
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
      {
        name: 'authors',
        label: 'Authors',
        path: 'authors',
        entries: {
          format: 'json',
          fields: authorSchema,
        },
      },
      {
        name: 'docs',
        label: 'Documentation',
        path: 'docs',
        entries: {
          format: 'json',
          fields: docSchema,
        },
        collections: [
          {
            name: 'guides',
            label: 'Guides',
            path: 'guides',
            entries: {
              format: 'json',
              fields: docSchema,
            },
          },
          {
            name: 'api',
            label: 'API Reference',
            path: 'api',
            entries: {
              format: 'json',
              fields: docSchema,
            },
            collections: [
              {
                name: 'v1',
                label: 'v1',
                path: 'v1',
                entries: {
                  format: 'json',
                  fields: docSchema,
                },
              },
              {
                name: 'v2',
                label: 'v2',
                path: 'v2',
                entries: {
                  format: 'json',
                  fields: docSchema,
                },
              },
            ],
          },
        ],
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
