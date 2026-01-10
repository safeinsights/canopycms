'use client'

import React, { useMemo } from 'react'

import type { CanopyClientConfig } from '../config'
import type { FormValue } from './FormRenderer'
import type { EditorProps } from './Editor'
import { Editor } from './Editor'
import { buildEditorCollections, buildPreviewBaseByCollection } from './editor-config'

export interface CanopyEditorProps
  extends Omit<
    EditorProps,
    'collections' | 'previewBaseByCollection' | 'title' | 'subtitle' | 'themeOptions' | 'entries'
  > {
  config: CanopyClientConfig
  entries?: EditorProps['entries']
}

export const CanopyEditor: React.FC<CanopyEditorProps> = ({
  config,
  entries = [],
  initialSelectedId,
  initialValues,
  renderPreview,
  onCreateEntry,
  branchName,
  branchMode,
}) => {
  const collections = useMemo(() => buildEditorCollections(config.flatSchema), [config.flatSchema])
  const previewBase = useMemo(
    () => ({
      ...buildPreviewBaseByCollection(config, config.flatSchema),
      ...(config.editor?.previewBase ?? {}),
    }),
    [config]
  )
  const resolvedBranchName = branchName ?? config.defaultBaseBranch ?? 'main'
  const resolvedBranchMode = branchMode ?? config.mode ?? 'local-simple'
  const resolvedTitle = config.editor?.title ?? 'CanopyCMS Editor'
  const resolvedSubtitle = config.editor?.subtitle
  const resolvedTheme = (config.editor?.theme as EditorProps['themeOptions']) ?? undefined

  return (
    <Editor
      entries={entries}
      title={resolvedTitle}
      subtitle={resolvedSubtitle}
      branchName={resolvedBranchName}
      branchMode={resolvedBranchMode}
      initialSelectedId={initialSelectedId}
      initialValues={initialValues as Record<string, FormValue> | undefined}
      renderPreview={renderPreview}
      onCreateEntry={onCreateEntry}
      collections={collections}
      previewBaseByCollection={previewBase}
      themeOptions={resolvedTheme}
      AccountComponent={config.editor?.AccountComponent}
      onAccountClick={config.editor?.onAccountClick}
      onLogoutClick={config.editor?.onLogoutClick}
    />
  )
}

export default CanopyEditor
