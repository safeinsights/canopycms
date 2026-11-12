'use client'

import { useState } from 'react'
import { Button, Text } from '@mantine/core'

import { EDITOR_ACTIONS } from '../copy'
import { releaseHoldConsequences } from '../conflict-notice'
import { ConfirmDeleteModal } from './ConfirmDeleteModal'

/**
 * What a release came to: released (or already gone), or refused with a message and its tone,
 * `warning` where nothing is lost yet or the outcome is unknown.
 */
export type ReleaseOutcome = { released: true } | { error: string; tone: 'warning' | 'error' }

/**
 * An admin's way out of a branch held because its conflict record was set aside
 * (api/merge-conflicts.ts `releaseHold`), behind a confirm that says what is lost. A refusal shows
 * in the confirm, which stays open; a release closes it.
 */
export function ReleaseHoldButton({
  branchLabel,
  onRelease,
}: {
  /** The branch as the bar names it, which the confirm names. */
  branchLabel?: string
  onRelease: () => Promise<ReleaseOutcome>
}) {
  const [open, setOpen] = useState(false)
  const [releasing, setReleasing] = useState(false)
  const [refusal, setRefusal] = useState<Extract<ReleaseOutcome, { error: string }>>()
  return (
    <>
      <Button
        size="compact-sm"
        variant="default"
        style={{ flexShrink: 0 }}
        onClick={() => {
          setRefusal(undefined)
          setOpen(true)
        }}
        data-testid="release-hold"
      >
        {EDITOR_ACTIONS.releaseHold}
      </Button>
      <ConfirmDeleteModal
        isOpen={open}
        title={
          branchLabel ? `Release the hold on "${branchLabel}"?` : "Release this branch's hold?"
        }
        message={releaseHoldConsequences}
        confirmLabel={EDITOR_ACTIONS.releaseHold}
        loading={releasing}
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          setReleasing(true)
          setRefusal(undefined)
          try {
            const outcome = await onRelease()
            if ('released' in outcome) setOpen(false)
            else setRefusal(outcome)
          } finally {
            setReleasing(false)
          }
        }}
      >
        {refusal && (
          <Text
            size="sm"
            role="alert"
            c={
              refusal.tone === 'warning'
                ? 'var(--mantine-color-yellow-text)'
                : 'var(--mantine-color-red-text)'
            }
            data-testid="release-hold-refusal"
          >
            {refusal.error}
          </Text>
        )}
      </ConfirmDeleteModal>
    </>
  )
}
