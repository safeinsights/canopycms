/**
 * Editor Context Providers
 *
 * These contexts consolidate editor-wide state and dependencies:
 *
 * - ApiClientContext: Dependency injection for API client (replaces lazy singletons)
 * - EditorStateContext: Loading states, modal states, preview data
 *
 * Usage:
 * ```tsx
 * <ApiClientProvider>
 *   <EditorStateProvider>
 *     <Editor />
 *   </EditorStateProvider>
 * </ApiClientProvider>
 * ```
 */

export {
  ApiClientProvider,
  useApiClient,
  useOptionalApiClient,
  type ApiClient,
  type ApiClientProviderProps,
} from './ApiClientContext'

export {
  EditorStateProvider,
  useEditorState,
  useEditorLoading,
  useEditorModals,
  useEditorPreview,
  type EditorState,
  type EditorStateActions,
  type EditorStateContextValue,
  type EditorStateProviderProps,
  type LoadingState,
  type ModalState,
  type PreviewState,
} from './EditorStateContext'
