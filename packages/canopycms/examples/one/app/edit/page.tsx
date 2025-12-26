'use client'

import { useClerkAuthConfig } from 'canopycms-auth-clerk/client'
import { CanopyEditorPage } from 'canopycms/client'
import config from '../../canopycms.config'

export default function EditPage() {
  const clerkAuth = useClerkAuthConfig()

  const clientConfig = config.client(clerkAuth)

  const EditorPage = CanopyEditorPage(clientConfig)
  return <EditorPage searchParams={{}} />
}
