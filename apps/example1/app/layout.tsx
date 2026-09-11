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

// ClerkProvider goes INSIDE <body>, not around <html>. Clerk Core 3
// (@clerk/nextjs 7.x) requires this; the pre-7.x shape here was
// `<ClerkProvider>{<html>...</html>}</ClerkProvider>`.
//
// Switching only the wrapper inside <body> also removes the second copy of the
// document skeleton this used to carry, so the dev-auth and Clerk paths can no
// longer drift in anything but the provider itself.
const RootLayout = ({ children }: { children: React.ReactNode }) => (
  <html lang="en">
    <body>{authMode === 'clerk' ? <ClerkProvider>{children}</ClerkProvider> : children}</body>
  </html>
)

export default RootLayout
