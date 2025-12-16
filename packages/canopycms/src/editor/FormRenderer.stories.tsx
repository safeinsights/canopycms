import type { Meta, StoryObj } from '@storybook/react'
import { useMemo, useState } from 'react'

import type { FieldConfig } from '../config'
import { FormRenderer } from './FormRenderer'

type HeroBlock = { template: 'hero'; value: { headline?: string; body?: string } }
type CtaBlock = { template: 'cta'; value: { title?: string; ctaText?: string } }
type PostBlock = HeroBlock | CtaBlock

interface PostValue {
  title: string
  author: string
  tags: string[]
  published: boolean
  body: string
  seo: { title?: string; description?: string }
  features: Array<{ title?: string; description?: string }>
  blocks: PostBlock[]
  [key: string]: unknown
}

const meta: Meta<typeof FormRenderer> = {
  title: 'Editor/FormRenderer',
  component: FormRenderer,
}

export default meta
type Story = StoryObj<typeof FormRenderer>

const authors = [
  { id: 'authors/alice', name: 'Alice' },
  { id: 'authors/bob', name: 'Bob' },
]

const postSchema: FieldConfig[] = [
  { name: 'title', type: 'string', label: 'Title' },
  {
    name: 'author',
    type: 'reference',
    label: 'Author',
    options: authors.map((a) => ({ label: a.name, value: a.id })),
    required: true,
  },
  {
    name: 'tags',
    type: 'select',
    label: 'Tags',
    list: true,
    options: ['typed', 'fast', 'lambda-friendly'],
  },
  { name: 'published', type: 'boolean', label: 'Published' },
  { name: 'body', type: 'mdx', label: 'Body' },
  {
    name: 'seo',
    type: 'object',
    label: 'SEO',
    fields: [
      { name: 'title', type: 'string', label: 'Meta title' },
      { name: 'description', type: 'string', label: 'Meta description' },
    ],
  },
  {
    name: 'features',
    type: 'object',
    label: 'Key features',
    list: true,
    fields: [
      { name: 'title', type: 'string' },
      { name: 'description', type: 'string' },
    ],
  },
  {
    name: 'blocks',
    type: 'block',
    templates: [
      {
        name: 'hero',
        label: 'Hero',
        fields: [
          { name: 'headline', type: 'string' },
          { name: 'body', type: 'markdown' },
        ],
      },
      {
        name: 'cta',
        label: 'CTA',
        fields: [
          { name: 'title', type: 'string' },
          { name: 'ctaText', type: 'string' },
        ],
      },
    ],
  },
]

const Preview: React.FC<{ value: PostValue }> = ({ value }) => {
  const authorMap = useMemo(() => Object.fromEntries(authors.map((a) => [a.id, a.name])), [])
  return (
    <div className="flex flex-col gap-3 rounded border border-gray-200 p-4">
      <div>
        <div className="text-sm font-semibold text-gray-800">{value.title}</div>
        <div className="text-xs text-gray-600">
          Author: {authorMap[value.author] ?? 'Unknown'} · {value.published ? 'Published' : 'Draft'}
        </div>
      </div>
      <div className="text-sm text-gray-700 whitespace-pre-wrap">{value.body}</div>
      <div className="flex flex-wrap gap-2">
        {(value.tags ?? []).map((tag) => (
          <span key={tag} className="rounded bg-blue-50 px-2 py-1 text-[11px] text-blue-700">
            {tag}
          </span>
        ))}
      </div>
      {value.seo && (
        <div className="rounded bg-gray-50 p-2 text-xs text-gray-700">
          <div className="font-semibold">SEO</div>
          <div>Title: {value.seo.title}</div>
          <div>Description: {value.seo.description}</div>
        </div>
      )}
      {Array.isArray(value.features) && value.features.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-xs font-semibold text-gray-700">Features</div>
          {value.features.map((feat, idx) => (
            <div key={`${feat.title}-${idx}`} className="rounded border border-gray-200 p-2 text-xs">
              <div className="font-semibold">{feat.title}</div>
              <div className="text-gray-700">{feat.description}</div>
            </div>
          ))}
        </div>
      )}
      {Array.isArray(value.blocks) && value.blocks.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-xs font-semibold text-gray-700">Blocks</div>
          {value.blocks.map((block, idx) => {
            if (block.template === 'hero') {
              return (
                <div key={`hero-${idx}`} className="rounded bg-indigo-50 p-3">
                  <div className="text-sm font-semibold">{block.value.headline}</div>
                  <div className="text-gray-700">{block.value.body}</div>
                </div>
              )
            }
            if (block.template === 'cta') {
              return (
                <div key={`cta-${idx}`} className="rounded bg-emerald-50 p-3">
                  <div className="text-sm font-semibold">{block.value.title}</div>
                  <button className="mt-1 rounded bg-emerald-600 px-3 py-1 text-xs text-white">
                    {block.value.ctaText}
                  </button>
                </div>
              )
            }
            return (
              <div key={`unknown-${idx}`} className="text-xs text-gray-500">
                Unknown block
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export const Default: Story = {
  render: () => {
    const [value, setValue] = useState<PostValue>({
      title: 'Hello World',
      author: 'authors/alice',
      tags: ['typed', 'fast'],
      published: false,
      body: 'Some **MDX** content that mirrors another example.',
      seo: {
        title: 'Hello World | CanopyCMS',
        description: 'Welcome to the demo story.',
      },
      features: [
        { title: 'Fast', description: 'Built for speed' },
        { title: 'Typed', description: 'Type-safe content' },
      ],
      blocks: [
        { template: 'hero', value: { headline: 'Hero block', body: 'Hero copy' } },
        { template: 'cta', value: { title: 'Try CanopyCMS', ctaText: 'Click me' } },
      ],
    })

    return (
      <div className="grid grid-cols-2 gap-4">
        <FormRenderer
          fields={postSchema}
          value={value}
          onChange={(next) => setValue(next as unknown as PostValue)}
        />
        <Preview value={value} />
      </div>
    )
  },
}
