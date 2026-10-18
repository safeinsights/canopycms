import React from 'react'

const SiteHeader = () => (
  <header className="border-b border-slate-200 bg-white">
    <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
      <a href="/" className="text-lg font-semibold text-slate-900">
        CanopyCMS Example
      </a>
      <nav aria-label="Site">
        <ul className="flex gap-4 text-sm text-slate-600">
          <li>
            <a href="/" className="hover:text-slate-900">
              Home
            </a>
          </li>
          <li>
            <a href="/docs" className="hover:text-slate-900">
              Docs
            </a>
          </li>
        </ul>
      </nav>
    </div>
  </header>
)

const SiteFooter = () => (
  <footer className="border-t border-slate-200 bg-white">
    <div className="mx-auto max-w-4xl px-6 py-6 text-sm text-slate-500">
      CanopyCMS Example · A demo site edited with CanopyCMS
    </div>
  </footer>
)

/**
 * The site's header and footer around a page. Every public page renders it, and the preview route
 * passes it as `createPreviewPage`'s `layout`, which sets `chrome` from the editor's "Show site
 * header and footer" toggle.
 */
export const SiteChrome = ({
  children,
  chrome = true,
}: {
  children: React.ReactNode
  chrome?: boolean
}) => (
  <>
    {chrome && <SiteHeader />}
    <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>
    {chrome && <SiteFooter />}
  </>
)
