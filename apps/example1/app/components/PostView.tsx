'use client'

import type { ComponentType } from 'react'
import React from 'react'

import type { BlockComponentRegistry } from 'canopycms'
import { useCanopyPreview } from 'canopycms/client'

import type { PostContent } from '../schemas'
import { AuthorCard } from './AuthorCard'
import { MarkdownBody } from './MarkdownBody'

type Blocks = PostContent['blocks'][number]

// Extra props threaded into every block component: which index this block sits at (for
// building live-preview field paths) and the fieldProps helper itself, from
// useCanopyPreview below.
type BlockExtraProps = {
  index: number
  fieldProps: ReturnType<typeof useCanopyPreview<PostContent>>['fieldProps']
}

// One component per block template, keyed off the schema's own template names.
// BlockComponentRegistry (from 'canopycms') makes this exhaustive at compile time:
// renaming, removing, or adding a template in schemas.ts is a compile error here,
// not a page that silently drops a section at render time. See the README's
// "Block Component Registries" for the recipe this follows.
const blockRegistry: BlockComponentRegistry<Blocks, BlockExtraProps> = {
  hero: ({ data, index, fieldProps }) => (
    <div
      {...fieldProps(['blocks', index])}
      className="rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3"
    >
      <div
        className="text-sm font-semibold text-indigo-900"
        {...fieldProps(['blocks', index, 'headline'])}
      >
        {data.headline}
      </div>
      <p className="mt-1 text-sm text-indigo-700" {...fieldProps(['blocks', index, 'body'])}>
        {data.body}
      </p>
    </div>
  ),
  cta: ({ data, index, fieldProps }) => (
    <div
      {...fieldProps(['blocks', index])}
      className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3"
    >
      <div
        className="text-sm font-semibold text-emerald-900"
        {...fieldProps(['blocks', index, 'title'])}
      >
        {data.title}
      </div>
      <button
        type="button"
        {...fieldProps(['blocks', index, 'ctaText'])}
        className="mt-2 inline-flex items-center rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-emerald-700"
      >
        {data.ctaText}
      </button>
    </div>
  ),
  // A shared/referenced block (see README's "Shared / Referenced Blocks"): `snippet` is
  // the resolved entry data, not an id — CanopyCMS resolves the reference before this
  // component ever sees it. Null-safe because the referenced entry can be deleted.
  sharedCta: ({ data, index, fieldProps }) => (
    <div
      {...fieldProps(['blocks', index])}
      className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3"
    >
      {data.snippet ? (
        <>
          <div
            className="text-sm font-semibold text-amber-900"
            {...fieldProps(['blocks', index, 'snippet'])}
          >
            {data.snippet.title}
          </div>
          <button
            type="button"
            className="mt-2 inline-flex items-center rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-amber-700"
          >
            {data.snippet.ctaText}
          </button>
        </>
      ) : (
        <p className="text-xs text-amber-700">Shared CTA snippet not found.</p>
      )}
    </div>
  ),
}

const renderBlock = (block: Blocks, extra: BlockExtraProps) => {
  // One contained assertion: `block.template` and `block.value` come from the same
  // object, so the lookup and the data always agree at runtime — TypeScript just can't
  // correlate a dynamic key lookup with a discriminated union's narrowing on its own.
  // What the registry above still guarantees at compile time is that every template
  // has exactly one component, so this lookup can never come back undefined.
  const Component = blockRegistry[block.template] as ComponentType<
    { data: typeof block.value } & BlockExtraProps
  >
  return <Component data={block.value} {...extra} />
}

export const PostView: React.FC<{ data: PostContent }> = ({ data }) => {
  const {
    data: liveData,
    isLoading,
    highlightEnabled,
    fieldProps,
  } = useCanopyPreview<PostContent>({
    initialData: data,
  })

  return (
    <article
      className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
      aria-live={highlightEnabled ? 'polite' : undefined}
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold text-slate-900" {...fieldProps('title')}>
            {liveData.title}
          </h1>
          <div className="flex items-center gap-2">
            <AuthorCard author={liveData.author} isLoading={isLoading.author} />
            <span className="text-xs text-slate-500">
              {liveData.published ? 'Published' : 'Draft'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {liveData.tags.map((tag, idx) => (
              <span
                key={tag}
                {...fieldProps(['tags', idx])}
                className="rounded-full bg-indigo-100 px-3 py-1 text-xs font-semibold text-indigo-700"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>

        <div className="prose prose-slate max-w-none" {...fieldProps('body')}>
          <MarkdownBody content={liveData.body} />
        </div>

        {liveData.blocks.length > 0 && (
          <div className="space-y-3">
            {liveData.blocks.map((block, idx) => (
              <React.Fragment key={idx}>
                {renderBlock(block, { index: idx, fieldProps })}
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
    </article>
  )
}

export default PostView
