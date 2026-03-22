import type { Meta, StoryObj } from '@storybook/react'
import { useMemo, useState } from 'react'

import { Badge, Box, Group, Paper, SegmentedControl, Stack, Text, Title } from '@mantine/core'

import type { FieldConfig } from '../config'
import { EditorPanes, type PaneLayout } from './EditorPanes'
import { FormRenderer, type FormValue } from './FormRenderer'

const meta: Meta<typeof EditorPanes> = {
  title: 'Editor/EditorPanes',
  component: EditorPanes,
  parameters: {
    layout: 'fullscreen',
  },
}

export default meta
type Story = StoryObj<typeof EditorPanes>

type HeroBlock = {
  template: 'hero'
  value: { headline?: string; body?: string }
}
type CtaBlock = { template: 'cta'; value: { title?: string; ctaText?: string } }
type PostBlock = HeroBlock | CtaBlock

interface PostValue {
  slug: string
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

const initialPost: PostValue = {
  slug: 'hello-world',
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
}

const PostPreview = ({ post, authorName }: { post: PostValue; authorName?: string }) => (
  <Stack gap="sm">
    <Group gap="xs" align="center">
      <Title order={3} fw={700}>
        {post.title}
      </Title>
      <Badge color={post.published ? 'green' : 'yellow'} variant="light">
        {post.published ? 'Published' : 'Draft'}
      </Badge>
    </Group>
    <Group gap="xs">
      <Text size="sm" c="dimmed">
        Author: {authorName ?? 'Unknown'}
      </Text>
      {post.tags.map((tag) => (
        <Badge key={tag} color="brand" variant="outline">
          {tag}
        </Badge>
      ))}
    </Group>
    <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
      {post.body || 'Body will render here.'}
    </Text>
    {post.blocks.length > 0 && (
      <Stack gap="sm">
        {post.blocks.map((block, idx) => {
          if (block.template === 'hero') {
            return (
              <Paper key={`${block.template}-${idx}`} withBorder radius="md" p="md" shadow="xs">
                <Text fw={600} size="sm" c="dimmed">
                  Hero block
                </Text>
                <Text fw={600}>{block.value.headline}</Text>
                <Text size="sm" c="dimmed">
                  {block.value.body ?? 'Hero body copy'}
                </Text>
              </Paper>
            )
          }
          const cta = (block as Extract<PostBlock, { template: 'cta' }>).value
          return (
            <Paper key={`${block.template}-${idx}`} withBorder radius="md" p="md" shadow="xs">
              <Text fw={600} size="sm" c="dimmed">
                Call to action
              </Text>
              <Text fw={600}>{cta.title}</Text>
              <Text size="sm" c="dimmed">
                {cta.ctaText ?? 'CTA copy'}
              </Text>
            </Paper>
          )
        })}
      </Stack>
    )}
    {post.features.length > 0 && (
      <Stack gap={6}>
        <Text size="xs" fw={600} c="dimmed">
          Features
        </Text>
        <Stack gap={6}>
          {post.features.map((feat, idx) => (
            <Paper key={`${feat.title}-${idx}`} withBorder radius="md" p="sm">
              <Text size="sm" fw={600}>
                {feat.title}
              </Text>
              <Text size="sm" c="dimmed">
                {feat.description}
              </Text>
            </Paper>
          ))}
        </Stack>
      </Stack>
    )}
  </Stack>
)

export const Default: Story = {
  render: () => {
    const [layout, setLayout] = useState<PaneLayout>('side')
    const [post, setPost] = useState<PostValue>(initialPost)
    const authorMap = useMemo(
      () => Object.fromEntries(authors.map((a) => [a.id, a.name])) as Record<string, string>,
      [],
    )

    return (
      <Box style={{ height: '90vh' }}>
        <Stack gap="sm" h="100%">
          <Group justify="space-between" align="center">
            <Stack gap={2}>
              <Text size="xs" c="dimmed">
                Form fields on the right mirror what CanopyCMS renders in apps. Toggle layout to
                simulate responsive editor panes.
              </Text>
            </Stack>
            <SegmentedControl
              size="xs"
              radius="md"
              data={[
                { value: 'side', label: 'Side by side' },
                { value: 'stacked', label: 'Stacked' },
              ]}
              value={layout}
              onChange={(value) => setLayout(value as PaneLayout)}
            />
          </Group>
          <EditorPanes
            onLayoutChange={setLayout}
            layout={layout}
            preview={
              <Box p="lg" bg="gray.0" h="100%">
                <PostPreview post={post} authorName={authorMap[post.author]} />
              </Box>
            }
            form={
              <Box p="lg">
                <FormRenderer
                  fields={postSchema}
                  value={post as unknown as FormValue}
                  onChange={(value) => setPost(value as PostValue)}
                />
              </Box>
            }
          />
        </Stack>
      </Box>
    )
  },
}
