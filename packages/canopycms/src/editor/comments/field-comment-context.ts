'use client'

import React, { createContext, useContext } from 'react'

export interface FieldCommentContextValue {
  /** The canonical canopy path of the field whose `FieldWrapper` provides this. */
  canopyPath: string
  /** That field's comment control, for its label row. */
  control: React.ReactNode
}

export const FieldCommentContext = createContext<FieldCommentContextValue | null>(null)

/**
 * The comment control for the field at `canopyPath`, for its `FieldLabel`'s `commentControl`
 * slot; null outside a `FieldWrapper` for that same path. Matching the path keeps a parent's
 * control out of a nested field's label, and out of list item titles, so each field shows one.
 */
export const useFieldCommentControl = (canopyPath: string | undefined): React.ReactNode => {
  const context = useContext(FieldCommentContext)
  if (!context || canopyPath === undefined || context.canopyPath !== canopyPath) return null
  return context.control
}
