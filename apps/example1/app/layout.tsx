import type { Metadata } from 'next'
import React from 'react'
import { ClerkProvider } from '@clerk/nextjs'

import './globals.css'

export const metadata: Metadata = {
  title: 'CanopyCMS Examples: One',
  description: 'Schema-driven form + preview using mock data',
}

const authMode = process.env.NEXT_PUBLIC_CANOPY_AUTH_MODE || 'dev'

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
