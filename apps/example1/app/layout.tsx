import type { Metadata } from 'next'
import React from 'react'
import { ClerkProvider } from '@clerk/nextjs'

import './globals.css'

export const metadata: Metadata = {
  title: 'CanopyCMS Examples: One',
  description: 'Schema-driven form + preview using mock data',
}

const RootLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  )
}

export default RootLayout
