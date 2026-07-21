import type { Metadata } from 'next'
import React from 'react'
import { ClerkProvider } from '@clerk/nextjs'

import config from '../canopycms.config'
import './globals.css'

export const metadata: Metadata = {
  title: 'CanopyCMS Examples: One',
  description: 'Schema-driven form + preview using mock data',
}

// Mirrors the server-side auth selection in app/lib/canopy.ts: in prod mode
// Clerk is always used, so the provider must be mounted even if the env var
// was forgotten (see app/edit/page.tsx for the matching edit-page selection).
const authMode =
  config.client().mode === 'prod' || process.env.NEXT_PUBLIC_CANOPY_AUTH_MODE === 'clerk'
    ? 'clerk'
    : 'dev'

const RootLayout = ({ children }: { children: React.ReactNode }) => {
  const content = (
    <html lang="en">
      <body>{children}</body>
    </html>
  )

  if (authMode === 'clerk') {
    return <ClerkProvider>{content}</ClerkProvider>
  }

  return content
}

export default RootLayout
