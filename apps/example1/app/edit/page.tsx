'use client'

import { useState } from 'react'
import type { CanopyClientConfig } from 'canopycms'
import { useClerkAuthConfig } from 'canopycms-auth-clerk/client'
import { useDevAuthConfig } from 'canopycms-auth-dev/client'
import { NextCanopyEditorPage } from 'canopycms-next/client'
import config from '../../canopycms.config'

const authMode = process.env.NEXT_PUBLIC_CANOPY_AUTH_MODE || 'dev'

function EditPageWithAuth({ authConfig }: { authConfig: Pick<CanopyClientConfig, 'editor'> }) {
  const [EditorPage] = useState(() => NextCanopyEditorPage(config.client(authConfig)))
  return <EditorPage />
}

function DevEditPage() {
  return <EditPageWithAuth authConfig={useDevAuthConfig()} />
}

function ClerkEditPage() {
  return <EditPageWithAuth authConfig={useClerkAuthConfig()} />
}

export default authMode === 'clerk' ? ClerkEditPage : DevEditPage
