import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'CanopyCMS Dual-Build Fixture',
  description: 'CI fixture verifying the static-export / CMS-server build split',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
