'use client'

import { NextCanopyEditorPage } from 'canopycms-next/client'
import config from '../../canopycms.config'

export default function EditPage() {
  const clientConfig = config.client()

  const EditorPage = NextCanopyEditorPage(clientConfig)
  return <EditorPage />
}
