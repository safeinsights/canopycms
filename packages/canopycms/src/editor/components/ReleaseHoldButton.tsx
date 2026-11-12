'use client'

import { useState } from 'react'
import { Button } from '@mantine/core'

import { EDITOR_ACTIONS } from '../copy'
import { releaseHoldConsequences } from '../conflict-notice'
import { ConfirmDeleteModal } from './ConfirmDeleteModal'

/**
 * An admin's way out of a branch held because its conflict record was set aside
 * (api/merge-conflicts.ts `releaseHold`), behind a confirm that says what is lost. `onRelease`
 * resolves whether the hold was released, which closes the confirm.
 */
export function ReleaseHoldButton({ onRelease }: { onRelease: () => Promise<boolean> }) {
  const [open, setOpen] = useState(false)
  const [releasing, setReleasing] = useState(false)
  return (
    <>
      <Button
        size="compact-sm"
        variant="default"
        style={{ flexShrink: 0 }}
        onClick={() => setOpen(true)}
        data-testid="release-hold"
      >
        {`${EDITOR_ACTIONS.releaseHold}…`}
      </Button>
      <ConfirmDeleteModal
        isOpen={open}
        title="Release this branch?"
        message={releaseHoldConsequences}
        confirmLabel={EDITOR_ACTIONS.releaseHold}
        loading={releasing}
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          setReleasing(true)
          try {
            if (await onRelease()) setOpen(false)
          } finally {
            setReleasing(false)
          }
        }}
      />
    </>
  )
}
