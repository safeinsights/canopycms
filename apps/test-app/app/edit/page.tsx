'use client'

import { CanopyEditorPage } from 'canopycms/client'
import config from '../../canopycms.config'

export default function EditPage() {
  const clientConfig = config.client()

  const EditorPage = CanopyEditorPage(clientConfig)
  return <EditorPage searchParams={{}} />
}
