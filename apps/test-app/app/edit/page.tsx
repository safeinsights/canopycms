'use client'

import { NextCanopyEditorPage } from 'canopycms-next/client'
import { useDevAuthConfig } from 'canopycms-auth-dev/client'
import config from '../../canopycms.config'

// Disable static generation for this page
export const dynamic = 'force-dynamic'

export default function EditPage() {
  const devAuth = useDevAuthConfig()
  const clientConfig = config.client(devAuth)

  const EditorPage = NextCanopyEditorPage(clientConfig)
  return <EditorPage />
}
