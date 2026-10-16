import React from 'react'
import { Alert } from '@mantine/core'
import { IconAlertCircle, IconAlertTriangle } from '@tabler/icons-react'
import { getErrorMessage } from '../../utils/error'
import { MayHaveLandedError } from '../unanswered'

/** A comment write's failure, and whether the write may have landed anyway. */
export interface CommentWriteFailure {
  message: string
  mayHaveLanded: boolean
}

export const toCommentWriteFailure = (err: unknown): CommentWriteFailure => ({
  message: getErrorMessage(err),
  mayHaveLanded: err instanceof MayHaveLandedError,
})

/** A failed comment write: red, or yellow when it may have been posted. */
export function CommentWriteAlert({
  failure,
  onClose,
}: {
  failure: CommentWriteFailure
  onClose: () => void
}) {
  return (
    <Alert
      icon={failure.mayHaveLanded ? <IconAlertTriangle size={16} /> : <IconAlertCircle size={16} />}
      color={failure.mayHaveLanded ? 'yellow' : 'red'}
      variant="light"
      onClose={onClose}
      withCloseButton
    >
      {failure.message}
    </Alert>
  )
}
