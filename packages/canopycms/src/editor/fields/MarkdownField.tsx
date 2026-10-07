'use client'

import React, { Suspense, useId, useRef, useCallback, useEffect, useState } from 'react'

import { Alert, Button, Group, Text, Textarea } from '@mantine/core'

import type { MDXEditorMethods } from '@mdxeditor/editor'
import { InsertEntryLink } from './entry-link'
import { MdxImageDialog } from './MdxImageDialog'
import { useApiClient, useAssetContext } from '../context'
import { editorImageSrc } from '../media/editor-image-src'
import { uploadAsset } from '../media/upload-asset'
import { FieldDescription, groupDescriptionProps } from './FieldDescription'

export interface MarkdownFieldProps {
  id?: string
  label?: string
  description?: string
  value: string
  onChange: (value: string) => void
  dataCanopyField?: string
}

const MDXEditorLazy = React.lazy(async () => {
  const [
    {
      MDXEditor,
      headingsPlugin,
      listsPlugin,
      quotePlugin,
      thematicBreakPlugin,
      markdownShortcutPlugin,
      linkPlugin,
      linkDialogPlugin,
      imagePlugin,
      tablePlugin,
      toolbarPlugin,
      codeBlockPlugin,
      codeMirrorPlugin,
      BoldItalicUnderlineToggles,
      BlockTypeSelect,
      ListsToggle,
      CreateLink,
      InsertImage,
      InsertTable,
      InsertThematicBreak,
      CodeToggle,
      InsertCodeBlock,
      UndoRedo,
      Separator,
      insertMarkdown$,
      usePublisher,
      useCellValues,
      saveImage$,
      closeImageDialog$,
      imageDialogState$,
    },
    { mdxJsxPlugins },
  ] = await Promise.all([import('@mdxeditor/editor'), import('./mdx-jsx-support')])

  const EntryLinkToolbarButton: React.FC = () => {
    const insertMarkdown = usePublisher(insertMarkdown$)
    return <InsertEntryLink onInsert={insertMarkdown} />
  }

  /**
   * Bridges mdxeditor's realm cells (reachable only once this lazy chunk has
   * loaded) into MdxImageDialog's plain-props interface, so that component
   * never imports `@mdxeditor/editor` at runtime — same pattern as
   * `EntryLinkToolbarButton` above.
   */
  const MdxImageDialogBridge: React.FC = () => {
    const [state] = useCellValues(imageDialogState$)
    const saveImage = usePublisher(saveImage$)
    const closeImageDialog = usePublisher(closeImageDialog$)
    return <MdxImageDialog state={state} onSave={saveImage} onClose={closeImageDialog} />
  }

  const WrappedEditor: React.FC<{
    markdown: string
    onChange: (value: string, initialMarkdownNormalize: boolean) => void
    onError: (payload: { error: string; source: string }) => void
    editorRef?: React.Ref<MDXEditorMethods>
    imageUploadHandler: (file: File) => Promise<string>
    imagePreviewHandler: (src: string) => Promise<string>
  }> = ({ markdown, onChange, onError, editorRef, imageUploadHandler, imagePreviewHandler }) => {
    return (
      <MDXEditor
        ref={editorRef}
        markdown={markdown}
        onChange={onChange}
        onError={onError}
        plugins={[
          headingsPlugin(),
          listsPlugin(),
          quotePlugin(),
          thematicBreakPlugin(),
          markdownShortcutPlugin(),
          linkPlugin(),
          linkDialogPlugin(),
          imagePlugin({
            imageUploadHandler,
            imagePreviewHandler,
            ImageDialog: MdxImageDialogBridge,
          }),
          tablePlugin(),
          ...mdxJsxPlugins(),
          codeBlockPlugin({ defaultCodeBlockLanguage: '' }),
          codeMirrorPlugin({
            codeBlockLanguages: {
              '': 'Plain text',
              js: 'JavaScript',
              ts: 'TypeScript',
              tsx: 'TSX',
              jsx: 'JSX',
              css: 'CSS',
              html: 'HTML',
              json: 'JSON',
              bash: 'Bash',
              python: 'Python',
              yaml: 'YAML',
              markdown: 'Markdown',
            },
          }),
          toolbarPlugin({
            toolbarContents: () => (
              <>
                <UndoRedo />
                <Separator />
                <BoldItalicUnderlineToggles />
                <CodeToggle />
                <Separator />
                <BlockTypeSelect />
                <Separator />
                <ListsToggle />
                <Separator />
                <CreateLink />
                <EntryLinkToolbarButton />
                <InsertImage />
                <InsertTable />
                <InsertThematicBreak />
                <InsertCodeBlock />
              </>
            ),
          }),
        ]}
        contentEditableClassName="canopy-mdx-content"
      />
    )
  }

  return { default: WrappedEditor }
})

const editorWrapperStyle: React.CSSProperties = {
  background: '#fff',
  border: '1px solid var(--mantine-color-gray-4, #ced4da)',
  borderRadius: 'var(--mantine-radius-sm, 4px)',
  overflow: 'hidden',
}

/**
 * Mantine's global CSS reset strips styles from semantic HTML elements.
 * Restore them inside the MDXEditor content area so formatting is visible.
 */
const EditorContentStyles: React.FC = () => (
  <style>{`
    .canopy-mdx-content { min-height: 120px; padding: 8px 12px; }
    .canopy-mdx-content ul { list-style-type: disc; padding-left: 1.5em; margin: 0.5em 0; }
    .canopy-mdx-content ol { list-style-type: decimal; padding-left: 1.5em; margin: 0.5em 0; }
    .canopy-mdx-content ul ul { list-style-type: circle; }
    .canopy-mdx-content ul ul ul { list-style-type: square; }
    .canopy-mdx-content li { display: list-item; }
    .canopy-mdx-content h1 { font-size: 2em; font-weight: 700; margin: 0.67em 0; }
    .canopy-mdx-content h2 { font-size: 1.5em; font-weight: 600; margin: 0.83em 0; }
    .canopy-mdx-content h3 { font-size: 1.17em; font-weight: 600; margin: 1em 0; }
    .canopy-mdx-content h4 { font-size: 1em; font-weight: 600; margin: 1.33em 0; }
    .canopy-mdx-content h5 { font-size: 0.83em; font-weight: 600; margin: 1.67em 0; }
    .canopy-mdx-content h6 { font-size: 0.67em; font-weight: 600; margin: 2.33em 0; }
    .canopy-mdx-content blockquote {
      border-left: 3px solid var(--mantine-color-gray-4, #ced4da);
      padding-left: 1em;
      margin: 0.5em 0;
      color: var(--mantine-color-gray-7, #495057);
    }
    .canopy-mdx-content hr { border: none; border-top: 1px solid var(--mantine-color-gray-4, #ced4da); margin: 1em 0; }
    .canopy-mdx-content p { margin: 0.75em 0; }
    .canopy-mdx-content a { color: var(--mantine-color-blue-6, #228be6); text-decoration: underline; }
    .canopy-mdx-content img { max-width: 100%; height: auto; }
    .canopy-mdx-content .canopy-mdx-jsx {
      border: 1px dashed var(--mantine-color-gray-4, #ced4da);
      border-radius: 4px;
      padding: 2px 8px;
      margin: 0.5em 0;
    }
    .canopy-mdx-content .canopy-mdx-jsx-inline { display: inline-block; margin: 0 2px; }
    .canopy-mdx-content .canopy-mdx-jsx-tag {
      font-family: var(--mantine-font-family-monospace, monospace);
      font-size: 0.8em;
      color: var(--mantine-color-gray-6, #868e96);
    }
  `}</style>
)

const FallbackTextarea: React.FC<Pick<MarkdownFieldProps, 'value' | 'onChange'>> = ({
  value,
  onChange,
}) => (
  <Textarea
    value={value}
    onChange={(e) => onChange(e.currentTarget.value)}
    placeholder="Loading markdown editor..."
    autosize
    minRows={6}
    size="sm"
    readOnly
  />
)

/**
 * `source` is a textarea over the value, chosen by the user (`reason: null`) or
 * forced because MDXEditor rejected the value and would emit no edits to it.
 */
type EditorMode =
  | { kind: 'rich' }
  | { kind: 'source'; reason: null }
  | { kind: 'source'; reason: string; failedValue: string }

export const MarkdownField: React.FC<MarkdownFieldProps> = ({
  id,
  label,
  description,
  value,
  onChange,
  dataCanopyField,
}) => {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const editorRef = useRef<MDXEditorMethods>(null)
  const lastExternalValue = useRef(value)
  const lastRejectedSource = useRef<string | null>(null)
  const apiClient = useApiClient()
  const [mode, setMode] = useState<EditorMode>({ kind: 'rich' })

  // Drives both MDXEditor's drag/drop/paste upload and the custom image
  // dialog's Upload tab via the same presign/finalize-or-proxied pipeline
  // (media/upload-asset.ts). Memoized on the API client (itself memoized by
  // ApiClientProvider) so MDXEditor's plugin list doesn't churn per keystroke.
  const imageUploadHandler = useCallback(
    async (file: File) => {
      const asset = await uploadAsset(apiClient, file)
      return asset.src
    },
    [apiClient],
  )

  // MDXEditor displays each body image at whatever this resolves; the markdown keeps its src.
  const { baseUrl: assetBaseUrl } = useAssetContext()
  const imagePreviewHandler = useCallback(
    async (src: string) => editorImageSrc(src, assetBaseUrl),
    [assetBaseUrl],
  )

  // Sync external value changes into the editor, recording them even while none
  // is mounted, so a later return to an earlier value is still a change.
  useEffect(() => {
    if (value === lastExternalValue.current) return
    lastExternalValue.current = value
    editorRef.current?.setMarkdown(value)
  }, [value])

  const emitChange = useCallback(
    (newValue: string) => {
      lastExternalValue.current = newValue
      onChange(newValue)
    },
    [onChange],
  )

  // Dropped: MDXEditor's re-serialization of the document it was mounted with
  // (flagged `initialMarkdownNormalize`; it would mark an unedited entry
  // modified), and inserted markdown it rejected, which it reports as the
  // whole document.
  const handleEditorChange = useCallback(
    (newValue: string, initialMarkdownNormalize: boolean) => {
      if (initialMarkdownNormalize || newValue === lastRejectedSource.current) return
      emitChange(newValue)
    },
    [emitChange],
  )

  // MDXEditor can report the error while rendering (it imports as it is
  // created), hence the microtask. The rejected document is this render's
  // `value`: MDXEditor is created from it, and gets this handler again before
  // the sync effect hands it a later value.
  const handleEditorError = useCallback(
    ({ error, source }: { error: string; source: string }) => {
      lastRejectedSource.current = source
      queueMicrotask(() => setMode({ kind: 'source', reason: error, failedValue: value }))
    },
    [value],
  )

  // Edits in the fallback stay in it: the edited text is no more likely to load.
  const handleSourceChange = useCallback(
    (newValue: string) => {
      setMode((current) =>
        current.kind === 'source' && current.reason !== null
          ? { ...current, failedValue: newValue }
          : current,
      )
      emitChange(newValue)
    },
    [emitChange],
  )

  // A fallback holds only for the value MDXEditor rejected.
  const showSource = mode.kind === 'source' && (mode.reason === null || mode.failedValue === value)

  return (
    <div
      id={inputId}
      data-canopy-field={dataCanopyField}
      className="canopy-markdown-field"
      {...groupDescriptionProps(inputId, description)}
    >
      <Group justify="space-between" align="flex-end" mb={4} wrap="nowrap">
        {label ? (
          <Text size="sm" fw={500}>
            {label}
          </Text>
        ) : (
          <span />
        )}
        <Button
          variant="subtle"
          size="compact-xs"
          data-testid="markdown-mode-toggle"
          onClick={() => setMode(showSource ? { kind: 'rich' } : { kind: 'source', reason: null })}
        >
          {showSource ? 'Rich text' : 'Edit source'}
        </Button>
      </Group>
      <FieldDescription baseId={inputId} description={description} />
      <EditorContentStyles />
      {showSource ? (
        <>
          {mode.kind === 'source' && mode.reason !== null && (
            <Alert color="yellow" variant="light" mb="xs" data-testid="markdown-source-fallback">
              <Text size="sm">
                The rich-text editor can&apos;t show this content, so it is open as source. Your
                edits here are saved as usual.
              </Text>
              <Text size="xs" c="dimmed" mt={4}>
                {mode.reason}
              </Text>
            </Alert>
          )}
          <Textarea
            value={value}
            onChange={(e) => handleSourceChange(e.currentTarget.value)}
            aria-label={label ? `${label} (source)` : 'Markdown source'}
            data-testid="markdown-source-editor"
            autosize
            minRows={10}
            size="sm"
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          />
        </>
      ) : (
        <div style={editorWrapperStyle}>
          <Suspense fallback={<FallbackTextarea value={value} onChange={onChange} />}>
            <MDXEditorLazy
              markdown={value}
              onChange={handleEditorChange}
              onError={handleEditorError}
              editorRef={editorRef}
              imageUploadHandler={imageUploadHandler}
              imagePreviewHandler={imagePreviewHandler}
            />
          </Suspense>
        </div>
      )}
    </div>
  )
}
