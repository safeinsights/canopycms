'use client'

import React from 'react'

import { useCanopyPreview } from 'canopycms/client'

import type { PostContent } from '../schemas'
import { AuthorCard } from './AuthorCard'

export const PostView: React.FC<{ data: PostContent }> = ({ data }) => {
  const { data: liveData, isLoading, highlightEnabled, fieldProps } = useCanopyPreview<PostContent>({
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

        <div className="text-base leading-relaxed text-slate-800 whitespace-pre-wrap" {...fieldProps('body')}>
          {liveData.body}
        </div>

        {liveData.blocks.length > 0 && (
          <div className="space-y-3">
            {liveData.blocks.map((block, idx) => {
              if (block.template === 'hero') {
                return (
                  <div
                    key={`hero-${idx}`}
                    {...fieldProps(['blocks', idx])}
                    className="rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3"
                  >
                    <div
                      className="text-sm font-semibold text-indigo-900"
                      {...fieldProps(['blocks', idx, 'headline'])}
                    >
                      {block.value.headline}
                    </div>
                    <p
                      className="mt-1 text-sm text-indigo-700"
                      {...fieldProps(['blocks', idx, 'body'])}
                    >
                      {block.value.body}
                    </p>
                  </div>
                )
              }
              if (block.template === 'cta') {
                return (
                  <div
                    key={`cta-${idx}`}
                    {...fieldProps(['blocks', idx])}
                    className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3"
                  >
                    <div
                      className="text-sm font-semibold text-emerald-900"
                      {...fieldProps(['blocks', idx, 'title'])}
                    >
                      {block.value.title}
                    </div>
                    <button
                      type="button"
                      {...fieldProps(['blocks', idx, 'ctaText'])}
                      className="mt-2 inline-flex items-center rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-emerald-700"
                    >
                      {block.value.ctaText}
                    </button>
                  </div>
                )
              }
              return (
                <div key={`unknown-${idx}`} className="rounded-lg border border-dashed border-slate-200 px-3 py-2">
                  <p className="text-xs text-slate-500">Unknown block</p>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </article>
  )
}

export default PostView
