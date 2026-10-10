'use client'

import React, { Suspense, useId, useRef, useCallback, useEffect, useReducer, useState } from 'react'

import { Alert, Button, Group, Text, Textarea } from '@mantine/core'

import type { EditorSubscription, MDXEditorMethods } from '@mdxeditor/editor'
import { InsertEntryLink } from './entry-link'
import { MARKDOWN_EXPORT_OPTIONS } from './markdown-export-options'
import { createMarkdownFidelityPlugin } from './markdown-fidelity-visitors'
import { MdxImageDialog } from './MdxImageDialog'
import { createMdxJsxPlugins } from './mdx-jsx-support'
import { useApiClient, useAssetContext } from '../context'
import { editorImageSrc } from '../media/editor-image-src'
import { uploadAsset } from '../media/upload-asset'
import { FieldDescription, groupDescriptionProps } from './FieldDescription'
import { EditorErrorBoundary, type CaughtEditorError } from '../components/EditorErrorBoundary'
import { getErrorMessage, sanitizeErrorMessage } from '../../utils/error'
import {
  forgetRichTextFailure,
  recallRichTextFailure,
  rememberRichTextFailure,
} from './rich-text-failures'

export interface MarkdownFieldProps {
  id?: string
  label?: string
  description?: string
  value: string
  onChange: (value: string) => void
  dataCanopyField?: string
  /** The HTML tags the field accepts; the toolbar offers no action writing another. Omitted: any. */
  htmlTags?: ReadonlySet<string>
}

/** Text formats MDXEditor exports as an HTML tag, with that tag. */
const TAG_FORMATS = [
  ['underline', 'u'],
  ['subscript', 'sub'],
  ['superscript', 'sup'],
] as const

/** @internal Exported for the round-trip corpus test, which drives exactly this editor. */
export const MDXEditorLazy = React.lazy(async () => {
  // MDXEditor's only code import (theme.tsx loads its CSS); see mdx-jsx-support for why.
  const mdx = await import('@mdxeditor/editor')
  const {
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
    activeEditor$,
    $isImageNode,
    createRootEditorSubscription$,
    realmPlugin,
    Cell,
    // MDXEditor's own lexical instance: lexical keeps the active editor state per module, so
    // a separately resolved copy would throw inside this editor's `read()`.
    lexical: {
      $getNodeByKey,
      $getSelection,
      $isRangeSelection,
      COMMAND_PRIORITY_CRITICAL,
      FORMAT_TEXT_COMMAND,
      SET_TEXT_FORMAT_COMMAND,
      mergeRegister,
    },
  } = mdx
  const mdxJsxPlugins = createMdxJsxPlugins(mdx)

  /** The text formats whose tag the field refuses, kept current as props change. */
  const refusedFormats$ = Cell<readonly string[]>([])
  const refusedFormats = (htmlTags: ReadonlySet<string> | undefined) =>
    TAG_FORMATS.filter(([, tag]) => htmlTags?.has(tag) === false).map(([format]) => format)

  /**
   * Refuses adding a format whose tag the field refuses (toolbar, Cmd+U) and lets removing one
   * through: Lexical toggles a range off when its selection has the format, and passes a nested
   * editor's input commands up to the root's. Content is never rewritten: a stored tag stays for
   * the server's unchanged-field rule, and a pasted one reaches the server, which refuses it.
   */
  const tagFormatGuardPlugin = realmPlugin<{ htmlTags: ReadonlySet<string> | undefined }>({
    init(realm, params) {
      realm.pub(refusedFormats$, refusedFormats(params?.htmlTags))
      const refused = (format: string) => realm.getValue(refusedFormats$).includes(format)
      const guard: EditorSubscription = (editor) =>
        mergeRegister(
          editor.registerCommand(
            FORMAT_TEXT_COMMAND,
            (format, fromEditor) => {
              if (!refused(format)) return false
              // Lexical formats the dispatching editor's pending selection; inside the root's
              // update, where this runs for a nested command, `$getSelection()` is the root's.
              const selection = fromEditor.read('pending', () => $getSelection())
              return !($isRangeSelection(selection) && selection.hasFormat(format))
            },
            COMMAND_PRIORITY_CRITICAL,
          ),
          editor.registerCommand(
            SET_TEXT_FORMAT_COMMAND,
            (formats) =>
              Object.entries(formats).some(([format, on]) => on === true && refused(format)),
            COMMAND_PRIORITY_CRITICAL,
          ),
        )
      realm.pub(createRootEditorSubscription$, guard)
    },
    update(realm, params) {
      realm.pub(refusedFormats$, refusedFormats(params?.htmlTags))
    },
  })

  const markdownFidelityPlugin = createMarkdownFidelityPlugin(mdx)

  const EntryLinkToolbarButton: React.FC<{
    onInsert: (insert: () => void, markdown: string) => void
  }> = ({ onInsert }) => {
    const insertMarkdown = usePublisher(insertMarkdown$)
    return (
      <InsertEntryLink
        onInsert={(markdown) => onInsert(() => insertMarkdown(markdown), markdown)}
      />
    )
  }

  /**
   * Bridges mdxeditor's realm cells (reachable only once this lazy chunk has loaded) into
   * MdxImageDialog's plain-props interface, so that component never imports `@mdxeditor/editor`
   * at runtime — same pattern as `EntryLinkToolbarButton` above.
   */
  const MdxImageDialogBridge: React.FC = () => {
    const [state, editor] = useCellValues(imageDialogState$, activeEditor$)
    const saveImage = usePublisher(saveImage$)
    const closeImageDialog = usePublisher(closeImageDialog$)
    // With an `imagePreviewHandler`, MDXEditor seeds an edit dialog with the src the node was
    // first rendered with, not its current one, so saving after a src change would revert it.
    // Read the node's live src from the same editor `saveImage$` writes through.
    const liveState = React.useMemo(() => {
      if (state.type !== 'editing' || !editor) return state
      const src = editor.getEditorState().read(() => {
        const node = $getNodeByKey(state.nodeKey)
        return $isImageNode(node) ? node.getSrc() : undefined
      })
      return src === undefined
        ? state
        : { ...state, initialValues: { ...state.initialValues, src } }
    }, [state, editor])
    return <MdxImageDialog state={liveState} onSave={saveImage} onClose={closeImageDialog} />
  }

  const WrappedEditor: React.FC<{
    markdown: string
    onChange: (value: string, initialMarkdownNormalize: boolean) => void
    onError: (payload: { error: string; source: string }) => void
    onInsert: (insert: () => void, markdown: string) => void
    editorRef?: React.Ref<MDXEditorMethods>
    imageUploadHandler: (file: File) => Promise<string>
    imagePreviewHandler: (src: string) => Promise<string>
    htmlTags?: ReadonlySet<string>
  }> = ({
    markdown,
    onChange,
    onError,
    onInsert,
    editorRef,
    imageUploadHandler,
    imagePreviewHandler,
    htmlTags,
  }) => {
    const underline = htmlTags?.has('u') ?? true
    return (
      <MDXEditor
        ref={editorRef}
        markdown={markdown}
        onChange={onChange}
        onError={onError}
        toMarkdownOptions={MARKDOWN_EXPORT_OPTIONS}
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
            // A resized image exports as `<img>`.
            disableImageResize: htmlTags?.has('img') === false,
          }),
          tablePlugin(),
          ...mdxJsxPlugins(),
          markdownFidelityPlugin(),
          tagFormatGuardPlugin({ htmlTags }),
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
                <BoldItalicUnderlineToggles options={underline ? undefined : ['Bold', 'Italic']} />
                <CodeToggle />
                <Separator />
                <BlockTypeSelect />
                <Separator />
                <ListsToggle />
                <Separator />
                <CreateLink />
                <EntryLinkToolbarButton onInsert={onInsert} />
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

/** The textarea over a markdown value; `failure` is why the rich-text editor could not open it. */
export const MarkdownSourceEditor: React.FC<{
  label?: string
  value: string
  onChange: (value: string) => void
  failure?: string
}> = ({ label, value, onChange, failure }) => (
  <>
    {failure !== undefined && (
      <Alert color="yellow" variant="light" mb="xs" data-testid="markdown-source-fallback">
        <Text size="sm">
          This content couldn&apos;t be opened in the visual editor. You can still edit the text and
          save.
        </Text>
        <Text size="xs" c="dimmed" mt={4}>
          {failure}
        </Text>
      </Alert>
    )}
    <Textarea
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      aria-label={label ? `${label} (source)` : 'Markdown source'}
      data-testid="markdown-source-editor"
      autosize
      minRows={10}
      size="sm"
      styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
    />
  </>
)

export const MarkdownField: React.FC<MarkdownFieldProps> = ({
  id,
  label,
  description,
  value,
  onChange,
  dataCanopyField,
  htmlTags,
}) => {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const editorRef = useRef<MDXEditorMethods>(null)
  const lastExternalValue = useRef(value)
  const lastRejectedSource = useRef<string | null>(null)
  const pendingInsert = useRef<string | null>(null)
  const apiClient = useApiClient()
  const [sourceChosen, setSourceChosen] = useState(false)
  // Text this field's author edited in the fallback, which stays in source with the reason.
  const [editedFallback, setEditedFallback] = useState<{ value: string; reason: string } | null>(
    null,
  )
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const [rejectedInsert, setRejectedInsert] = useState<string | null>(null)
  const [editorGeneration, setEditorGeneration] = useState(0)

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
      setRejectedInsert(null)
      onChange(newValue)
    },
    [onChange],
  )

  // Dropped: MDXEditor's re-serialization of the document it was mounted with
  // (flagged `initialMarkdownNormalize`; it would mark an unedited entry
  // modified), and inserted markdown it rejected, which it emits as if that
  // snippet were the whole document.
  const handleEditorChange = useCallback(
    (newValue: string, initialMarkdownNormalize: boolean) => {
      if (initialMarkdownNormalize || newValue === lastRejectedSource.current) return
      emitChange(newValue)
    },
    [emitChange],
  )

  // MDXEditor reports a rejected insert synchronously, inside insertMarkdown
  // (with no selection it imports nothing, and reports nothing).
  const handleInsert = useCallback((insert: () => void, markdown: string) => {
    pendingInsert.current = markdown
    try {
      insert()
    } finally {
      pendingInsert.current = null
    }
  }, [])

  // A value the rich-text editor failed on opens as source, whether MDXEditor rejected it or
  // crashed rendering it; rich-text-failures.ts holds the record for the session. Text edited
  // from there stays in source in this field only, so it marks no other field.
  const failure =
    recallRichTextFailure(value) ??
    (editedFallback?.value === value ? editedFallback.reason : undefined)
  const showSource = sourceChosen || failure !== undefined

  // MDXEditor can report the error while rendering (it imports as it is
  // created), hence the microtask. Any rejection outside an insert is the
  // document, this render's `value`: MDXEditor is created from it, and gets
  // this handler again before the sync effect hands it a later value. `source`
  // can't identify it, because MDXEditor trims the document it mounts with.
  // Either way MDXEditor emits no further edits until an import succeeds, so a
  // rejected insert remounts it from the unchanged document.
  const handleEditorError = useCallback(
    ({ error, source }: { error: string; source: string }) => {
      lastRejectedSource.current = source
      const isInsert = pendingInsert.current !== null && source === pendingInsert.current
      queueMicrotask(() => {
        if (isInsert) {
          setRejectedInsert(error)
          setEditorGeneration((n) => n + 1)
        } else {
          rememberRichTextFailure(value, error)
          rerender()
        }
      })
    },
    [value],
  )

  const handleEditorCrash = useCallback(
    ({ error }: CaughtEditorError) => {
      rememberRichTextFailure(value, sanitizeErrorMessage(getErrorMessage(error)))
      rerender()
    },
    [value],
  )

  // Edits in the fallback stay in it: the edited text is no more likely to load.
  const handleSourceChange = (newValue: string) => {
    if (failure !== undefined) setEditedFallback({ value: newValue, reason: failure })
    emitChange(newValue)
  }

  const toggleMode = () => {
    if (!showSource) {
      setSourceChosen(true)
      return
    }
    // Asking for rich text tries the editor again on a value it failed on.
    forgetRichTextFailure(value)
    setEditedFallback(null)
    setSourceChosen(false)
    rerender()
  }

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
          onClick={toggleMode}
        >
          {showSource ? 'Rich text' : 'Edit source'}
        </Button>
      </Group>
      <FieldDescription baseId={inputId} description={description} />
      <EditorContentStyles />
      {showSource ? (
        <MarkdownSourceEditor
          label={label}
          value={value}
          onChange={handleSourceChange}
          failure={failure}
        />
      ) : (
        <div style={editorWrapperStyle}>
          {rejectedInsert !== null && (
            <Alert
              color="yellow"
              variant="light"
              mb="xs"
              withCloseButton
              onClose={() => setRejectedInsert(null)}
              data-testid="markdown-insert-rejected"
            >
              <Text size="sm">
                The rich-text editor can&apos;t show what was inserted, so nothing was added.
              </Text>
              <Text size="xs" c="dimmed" mt={4}>
                {rejectedInsert}
              </Text>
            </Alert>
          )}
          <EditorErrorBoundary
            context={{ boundary: 'rich-text', fieldPath: dataCanopyField }}
            fallback={() => null}
            onCaught={handleEditorCrash}
          >
            <Suspense fallback={<FallbackTextarea value={value} onChange={onChange} />}>
              <MDXEditorLazy
                key={editorGeneration}
                markdown={value}
                onChange={handleEditorChange}
                onError={handleEditorError}
                onInsert={handleInsert}
                editorRef={editorRef}
                imageUploadHandler={imageUploadHandler}
                imagePreviewHandler={imagePreviewHandler}
                htmlTags={htmlTags}
              />
            </Suspense>
          </EditorErrorBoundary>
        </div>
      )}
    </div>
  )
}
