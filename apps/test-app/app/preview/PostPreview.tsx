'use client'

import { withCanopyPreview, type CanopyPreviewViewProps } from 'canopycms-next/preview'

export interface PostData {
  title?: string
  tags?: string[]
  byline?: { name?: string }
}

function PostPreviewView({ data, fieldProps }: CanopyPreviewViewProps<PostData>) {
  return (
    <article data-testid="post-preview" className="p-8">
      <h1 {...fieldProps('title')}>{data?.title}</h1>
      <ul>
        {(data?.tags ?? []).map((tag, index) => (
          <li key={index} {...fieldProps(['tags', index])}>
            {tag}
          </li>
        ))}
      </ul>
      {data?.byline?.name && <p {...fieldProps('byline.name')}>By {data.byline.name}</p>}
    </article>
  )
}

export const PostPreview = withCanopyPreview<PostData>(PostPreviewView)
