'use client'

/**
 * Consolidates editor-wide loading, modal, and preview state in one place
 * instead of prop-drilling it through the Editor component.
 */

import React, { createContext, useContext, useCallback, useState, useMemo } from 'react'
import type { FormValue } from '../FormRenderer'

export interface LoadingState {
  branches: boolean
  entries: boolean
  comments: boolean
}

export interface ModalState {
  navigator: boolean
  branchManager: boolean
  groupManager: boolean
  permissionManager: boolean
  commentsPanel: boolean
}

export interface PreviewState {
  data: FormValue
  loading: FormValue
}

export interface EditorState {
  loading: LoadingState
  modals: ModalState
  preview: PreviewState
  /** True if any resource is loading */
  busy: boolean
}

export interface EditorStateActions {
  setLoading: (key: keyof LoadingState, value: boolean) => void
  openModal: (key: keyof ModalState) => void
  closeModal: (key: keyof ModalState) => void
  toggleModal: (key: keyof ModalState) => void
  setPreviewData: (data: FormValue) => void
  setPreviewLoading: (loading: FormValue) => void
}

export interface EditorStateContextValue {
  state: EditorState
  actions: EditorStateActions
}

const EditorStateContext = createContext<EditorStateContextValue | null>(null)

export interface EditorStateProviderProps {
  children: React.ReactNode
  /** Initial modal states (useful for deep linking) */
  initialModals?: Partial<ModalState>
}

export function EditorStateProvider({ children, initialModals }: EditorStateProviderProps) {
  const [loading, setLoadingState] = useState<LoadingState>({
    branches: false,
    entries: false,
    comments: false,
  })

  const [modals, setModals] = useState<ModalState>({
    navigator: false,
    branchManager: false,
    groupManager: false,
    permissionManager: false,
    commentsPanel: false,
    ...initialModals,
  })

  const [previewData, setPreviewDataState] = useState<FormValue>({})
  const [previewLoading, setPreviewLoadingState] = useState<FormValue>({})

  const busy = loading.branches || loading.entries || loading.comments

  const setLoading = useCallback((key: keyof LoadingState, value: boolean) => {
    setLoadingState((prev) => ({ ...prev, [key]: value }))
  }, [])

  const openModal = useCallback((key: keyof ModalState) => {
    setModals((prev) => ({ ...prev, [key]: true }))
  }, [])

  const closeModal = useCallback((key: keyof ModalState) => {
    setModals((prev) => ({ ...prev, [key]: false }))
  }, [])

  const toggleModal = useCallback((key: keyof ModalState) => {
    setModals((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const setPreviewData = useCallback((data: FormValue) => {
    setPreviewDataState(data)
  }, [])

  const setPreviewLoading = useCallback((loading: FormValue) => {
    setPreviewLoadingState(loading)
  }, [])

  const value = useMemo<EditorStateContextValue>(
    () => ({
      state: {
        loading,
        modals,
        preview: {
          data: previewData,
          loading: previewLoading,
        },
        busy,
      },
      actions: {
        setLoading,
        openModal,
        closeModal,
        toggleModal,
        setPreviewData,
        setPreviewLoading,
      },
    }),
    [
      loading,
      modals,
      previewData,
      previewLoading,
      busy,
      setLoading,
      openModal,
      closeModal,
      toggleModal,
      setPreviewData,
      setPreviewLoading,
    ],
  )

  return <EditorStateContext.Provider value={value}>{children}</EditorStateContext.Provider>
}

/**
 * Access the full editor state context.
 * Must be used within an EditorStateProvider.
 */
export function useEditorState(): EditorStateContextValue {
  const context = useContext(EditorStateContext)
  if (!context) {
    throw new Error('useEditorState must be used within an EditorStateProvider')
  }
  return context
}

/**
 * Convenience hook for loading states only.
 */
export function useEditorLoading() {
  const { state, actions } = useEditorState()
  return {
    ...state.loading,
    busy: state.busy,
    setLoading: actions.setLoading,
  }
}

/**
 * Convenience hook for modal states only.
 */
export function useEditorModals() {
  const { state, actions } = useEditorState()
  return {
    ...state.modals,
    openModal: actions.openModal,
    closeModal: actions.closeModal,
    toggleModal: actions.toggleModal,
  }
}

/**
 * Convenience hook for preview state only.
 */
export function useEditorPreview() {
  const { state, actions } = useEditorState()
  return {
    data: state.preview.data,
    loading: state.preview.loading,
    setData: actions.setPreviewData,
    setLoading: actions.setPreviewLoading,
  }
}
