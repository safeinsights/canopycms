'use client'

import React, { type Ref } from 'react'
import { Button, Loader, Tooltip } from '@mantine/core'
import { IconRefresh } from '@tabler/icons-react'
import { EDITOR_ACTIONS } from '../copy'
import {
  GETTING_LATEST_CHANGES,
  SLOW_NOTICE,
  WAITING_NOTICE,
  type BaseUpdateControl,
} from '../base-update-wait'

const TOOLTIP_EVENTS = { hover: true, focus: true, touch: true }

/** The Tooltip's text: why it waits, why it can't act, or what it does. */
export function getLatestChangesReason(control: BaseUpdateControl): string {
  if (control.requesting || control.wait !== 'none') {
    return control.wait === 'slow' ? SLOW_NOTICE : WAITING_NOTICE
  }
  return control.blockedReason ?? control.tooltip
}

/**
 * "Get latest changes", or "Getting latest changes…" with a spinner while the request stands. It
 * takes the wider label's width either way, so the bar never shifts. It can't act while it works
 * or while something blocks it, and stays focusable (`aria-disabled`) with its Tooltip saying why.
 * Only a block dims it: the working label is progress, read at full contrast.
 */
export function GetLatestChangesButton({
  control,
  buttonRef,
  testId = 'get-latest-changes-button',
}: {
  control: BaseUpdateControl
  buttonRef?: Ref<HTMLButtonElement>
  testId?: string
}) {
  const working = control.requesting || control.wait !== 'none'
  const blocked = working || !!control.blockedReason
  const tooltip = getLatestChangesReason(control)
  return (
    <Tooltip label={tooltip} events={TOOLTIP_EVENTS} multiline maw={320}>
      <Button
        ref={buttonRef}
        size="sm"
        variant="default"
        style={{ flexShrink: 0 }}
        leftSection={
          working ? (
            <Loader size={14} aria-hidden="true" />
          ) : (
            <IconRefresh size={14} aria-hidden="true" />
          )
        }
        onClick={() => {
          if (!blocked) control.onRequest()
        }}
        data-disabled={blocked && !working ? true : undefined}
        aria-disabled={blocked ? true : undefined}
        data-working={working || undefined}
        data-testid={testId}
      >
        <span style={{ display: 'inline-grid' }}>
          <span style={{ gridArea: '1 / 1', visibility: working ? 'hidden' : undefined }}>
            {EDITOR_ACTIONS.getLatestChanges}
          </span>
          <span style={{ gridArea: '1 / 1', visibility: working ? undefined : 'hidden' }}>
            {GETTING_LATEST_CHANGES}
          </span>
        </span>
      </Button>
    </Tooltip>
  )
}
