'use client'

import React from 'react'

import { Button, CopyButton } from '@mantine/core'
import { IconCheck, IconCopy } from '@tabler/icons-react'

import {
  formatErrorDetails,
  reportEditorError,
  type EditorErrorContext,
} from '../utils/editor-errors'

export interface CaughtEditorError {
  error: unknown
  context: EditorErrorContext
}

interface EditorErrorBoundaryProps {
  context: Omit<EditorErrorContext, 'componentStack'>
  /** A change shows the children again, without remounting healthy ones. */
  resetKey?: string
  fallback: (caught: CaughtEditorError) => React.ReactNode
  /** Runs after the error is reported. */
  onCaught?: (caught: CaughtEditorError) => void
  children: React.ReactNode
}

interface EditorErrorBoundaryState {
  error: { value: unknown; componentStack?: string } | null
  /** The `resetKey` the boundary last rendered under. */
  renderedUnder: string | undefined
}

/** Catches errors thrown while rendering its children and reports each through `reportEditorError`. */
export class EditorErrorBoundary extends React.Component<
  EditorErrorBoundaryProps,
  EditorErrorBoundaryState
> {
  state: EditorErrorBoundaryState = { error: null, renderedUnder: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<EditorErrorBoundaryState> {
    return { error: { value: error } }
  }

  static getDerivedStateFromProps(
    props: EditorErrorBoundaryProps,
    state: EditorErrorBoundaryState,
  ): Partial<EditorErrorBoundaryState> | null {
    if (props.resetKey === state.renderedUnder) return null
    return { error: null, renderedUnder: props.resetKey }
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    const caught = this.caught({ value: error, componentStack: info.componentStack ?? undefined })
    reportEditorError(error, caught.context)
    this.setState({ error: { value: error, componentStack: caught.context.componentStack } })
    this.props.onCaught?.(caught)
  }

  private caught(error: { value: unknown; componentStack?: string }): CaughtEditorError {
    return {
      error: error.value,
      context: { ...this.props.context, componentStack: error.componentStack },
    }
  }

  render(): React.ReactNode {
    return this.state.error
      ? this.props.fallback(this.caught(this.state.error))
      : this.props.children
  }
}

/** Copies the sanitised details of a caught error, for the author to pass on. */
export const CopyErrorDetailsButton: React.FC<{
  caught: CaughtEditorError
  size?: 'xs' | 'sm'
}> = ({ caught, size = 'xs' }) => (
  <CopyButton value={formatErrorDetails(caught.error, caught.context)}>
    {({ copied, copy }) => (
      <Button
        size={size}
        variant="light"
        color={copied ? 'teal' : 'gray'}
        leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
        onClick={copy}
        data-testid="copy-error-details"
      >
        {copied ? 'Copied' : 'Copy error details'}
      </Button>
    )}
  </CopyButton>
)
