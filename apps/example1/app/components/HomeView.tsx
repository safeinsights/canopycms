'use client'

import React from 'react'

import { sanitizeHref } from 'canopycms'
import { type CanopyPreviewViewProps, withCanopyPreview } from 'canopycms-next/preview'

import type { HomeContent } from '../schemas'
import { MarkdownBody } from './MarkdownBody'

/** What `loadHomeExtras` adds: a snapshot of the request, not the live draft. */
export interface HomeExtras {
  posts: Array<{ title: string; href: string }>
}

export const HomeView: React.FC<
  CanopyPreviewViewProps<HomeContent> & { extras: HomeExtras | undefined }
> = ({ data: liveData, fieldProps, extras }) => {
  const hero = liveData?.hero ?? { title: '', body: '' }
  const features = liveData?.features ?? []
  const cta = liveData?.cta ?? { text: '', link: '#' }
  const ctaHref = sanitizeHref(cta.link)

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold text-slate-900" {...fieldProps('hero.title')}>
          {hero.title}
        </h1>
        <div className="mt-3 text-base leading-relaxed text-slate-600" {...fieldProps('hero.body')}>
          <MarkdownBody content={hero.body} />
        </div>
        <a
          href={ctaHref}
          {...fieldProps('cta')}
          className="mt-5 inline-flex items-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-indigo-700"
        >
          {cta.text}
        </a>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-900">Features</h3>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {features.map((feat, idx) => (
            <div
              key={`${feat.title}-${idx}`}
              {...fieldProps(['features', idx])}
              className="rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3 shadow-sm"
            >
              <div className="text-sm font-semibold text-slate-900">{feat.title}</div>
              <p className="mt-1 text-sm text-slate-600">{feat.description}</p>
            </div>
          ))}
          {features.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
              Add features to see them listed here.
            </div>
          )}
        </div>
      </div>

      {extras && extras.posts.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-slate-900">Posts</h3>
          <ul className="mt-4 space-y-2 text-sm">
            {extras.posts.map((post) => (
              <li key={post.href}>
                <a href={sanitizeHref(post.href)} className="text-indigo-600 hover:underline">
                  {post.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// The live-preview form, rendered by app/preview and the public pages alike.
export const HomePreview = withCanopyPreview<HomeContent, HomeExtras>(HomeView)

export default HomeView
