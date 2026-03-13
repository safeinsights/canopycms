'use client'

import React from 'react'

import { useCanopyPreview } from 'canopycms/client'

import type { DocContent } from '../schemas'
import { MarkdownBody } from './MarkdownBody'

export const DocView: React.FC<{ data: DocContent }> = ({ data }) => {
  const { data: liveData, highlightEnabled, fieldProps } = useCanopyPreview<DocContent>({
    initialData: data,
  })

  return (
    <article
      className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"
      aria-live={highlightEnabled ? 'polite' : undefined}
    >
      <div className="max-w-3xl space-y-4">
        <div className="space-y-2">
          <h1 className="text-4xl font-bold text-slate-900" {...fieldProps('title')}>
            {liveData.title}
          </h1>
          {liveData.description && (
            <p className="text-lg text-slate-600" {...fieldProps('description')}>
              {liveData.description}
            </p>
          )}
        </div>

        <div
          className="prose prose-slate max-w-none"
          {...fieldProps('body')}
        >
          <MarkdownBody content={liveData.body} />
        </div>
      </div>
    </article>
  )
}

export default DocView
