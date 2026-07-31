'use client'

import { NextCanopyEditorPage } from 'canopycms-next/client'
import { useDevAuthConfig } from 'canopycms-auth-dev/client'
import config from '../../canopycms.config'

// CMS-only: `.server.tsx` so withCanopy's staticBuild pageExtensions
// excludes it entirely from the static export -- there is no plain
// `page.tsx` here, so the static build has no `/edit` route at all.
export const dynamic = 'force-dynamic'

export default function EditPage() {
  const devAuth = useDevAuthConfig()
  const clientConfig = config.client(devAuth)

  const EditorPage = NextCanopyEditorPage(clientConfig)
  return <EditorPage />
}
