import './globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'CanopyCMS Test App',
  description: 'Test app for Playwright E2E tests',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
