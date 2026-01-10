'use client'

import { useClerkAuthConfig } from 'canopycms-auth-clerk/client'
import { useDevAuthConfig } from 'canopycms-auth-dev/client'
import { NextCanopyEditorPage } from 'canopycms-next/client'
import config from '../../canopycms.config'

/**
 * Select auth config hook based on CANOPY_AUTH_MODE environment variable.
 * This must match the server-side auth plugin selection.
 */
function useAuthConfig() {
  const authMode = process.env.NEXT_PUBLIC_CANOPY_AUTH_MODE || 'dev'

  if (authMode === 'dev') {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useDevAuthConfig()
  }

  if (authMode === 'clerk') {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useClerkAuthConfig()
  }

  throw new Error(
    `Invalid NEXT_PUBLIC_CANOPY_AUTH_MODE: "${authMode}". Must be "dev" or "clerk".`
  )
}

export default function EditPage() {
  const authConfig = useAuthConfig()
  const clientConfig = config.client(authConfig)

  const EditorPage = NextCanopyEditorPage(clientConfig)
  return <EditorPage />
}
