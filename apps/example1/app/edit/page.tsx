'use client'

import { useClerkAuthConfig } from 'canopycms-auth-clerk/client'
import { NextCanopyEditorPage } from 'canopycms-next/client'
import config from '../../canopycms.config'

export default function EditPage() {
  const clerkAuth = useClerkAuthConfig()

  const clientConfig = config.client(clerkAuth)

  const EditorPage = NextCanopyEditorPage(clientConfig)
  return <EditorPage />
}
