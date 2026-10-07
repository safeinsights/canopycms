'use client'

import React, { useMemo } from 'react'

import type { CanopyClientConfig } from '../config'
import type { FormValue } from './FormRenderer'
import type { EditorProps } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { EditorAuthGate } from './EditorAuthGate'
import { buildEditorCollections } from './editor-config'

export interface CanopyEditorProps extends Omit<
  EditorProps,
  | 'collections'
  | 'previewBaseByCollection'
  | 'previewPrefix'
  | 'title'
  | 'subtitle'
  | 'themeOptions'
  | 'entries'
  | 'contentRoot'
  | 'operatingMode'
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
  customRenderers,
}) => {
  const collections = useMemo(() => buildEditorCollections(config.flatSchema), [config.flatSchema])
  // Empty string = branchless start; useBranchManager adopts the server's
  // detected default branch on the first branches.list() load.
  const resolvedBranchName =
    branchName ?? config.defaultActiveBranch ?? config.defaultBaseBranch ?? ''
  const resolvedTitle = config.editor?.title ?? 'CanopyCMS Editor'
  const resolvedSubtitle = config.editor?.subtitle
  const resolvedTheme = (config.editor?.theme as EditorProps['themeOptions']) ?? undefined

  // The gate owns the SWRProvider (keyed by user id), so it sits between the API client and the
  // editor: see EditorAuthGate for what a signed-out or lapsed session renders.
  return (
    <ApiClientProvider basePath={config.basePath}>
      <EditorAuthGate SignInComponent={config.editor?.SignInComponent} themeOptions={resolvedTheme}>
        <Editor
          entries={entries}
          title={resolvedTitle}
          subtitle={resolvedSubtitle}
          branchName={resolvedBranchName}
          operatingMode={config.mode}
          initialSelectedId={initialSelectedId}
          initialValues={initialValues as Record<string, FormValue> | undefined}
          renderPreview={renderPreview}
          onCreateEntry={onCreateEntry}
          customRenderers={customRenderers}
          collections={collections}
          contentRoot={config.contentRoot}
          entryLinkUrl={config.entryLinkUrl}
          previewBaseByCollection={config.editor?.previewBase}
          previewPrefix={config.editor?.previewPrefix}
          assetBaseUrl={config.assetBaseUrl}
          basePath={config.basePath}
          themeOptions={resolvedTheme}
          AccountComponent={config.editor?.AccountComponent}
          onAccountClick={config.editor?.onAccountClick}
          onLogoutClick={config.editor?.onLogoutClick}
        />
      </EditorAuthGate>
    </ApiClientProvider>
  )
}

export default CanopyEditor
