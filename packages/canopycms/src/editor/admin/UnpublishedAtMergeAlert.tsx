'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Alert, Anchor, Button, Code, Group, Stack, Text } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'
import { EDITOR_ACTIONS } from '../copy'
import { escapeForLog } from '../../utils/escape-text'

/** Marks each row's Dismiss, for the panel to move focus to once a row has gone. */
export const DISMISS_UNPUBLISHED_ATTRIBUTE = 'data-dismiss-unpublished'

export interface UnpublishedBranch {
  dirName: string
  name: string
  pullRequestUrl?: string
}

/** One branch, whose Dismiss asks in its own row: System health is already a modal. */
function UnpublishedRow({
  branch,
  onDismiss,
}: {
  branch: UnpublishedBranch
  onDismiss: (dirName: string) => Promise<void>
}) {
  const { dirName, pullRequestUrl } = branch
  const name = escapeForLog(branch.name)
  const [asking, setAsking] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const dismissRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const asked = useRef(false)
  const questionId = useId()

  // The button pressed is replaced each way, so focus follows to its counterpart.
  useEffect(() => {
    if (asking) confirmRef.current?.focus()
    else if (asked.current) dismissRef.current?.focus()
    asked.current = asking
  }, [asking])

  const dismiss = async () => {
    setDismissing(true)
    try {
      await onDismiss(dirName)
    } finally {
      setDismissing(false)
      setAsking(false)
    }
  }

  return (
    <Group gap="xs" justify="space-between" data-testid={`unpublished-branch-${dirName}`}>
      <Group gap="xs" style={{ minWidth: 0, flex: '1 1 200px' }}>
        <Code style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{name}</Code>
        {pullRequestUrl && (
          <Anchor
            href={pullRequestUrl}
            target="_blank"
            rel="noopener noreferrer"
            size="xs"
            c="var(--mantine-color-text)"
            underline="always"
          >
            View pull request
          </Anchor>
        )}
      </Group>
      {asking ? (
        <Group gap={4} style={{ maxWidth: '100%' }}>
          <Text id={questionId} size="xs">
            Dismiss this warning? It won&apos;t come back, and the branch can then be deleted.
          </Text>
          <Button
            ref={confirmRef}
            size="compact-xs"
            variant="default"
            loading={dismissing}
            aria-label={`Dismiss the warning for ${name}`}
            aria-describedby={questionId}
            data-testid={`confirm-dismiss-unpublished-${dirName}`}
            onClick={() => void dismiss()}
          >
            Dismiss
          </Button>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            disabled={dismissing}
            aria-label={`Cancel dismissing the warning for ${name}`}
            data-testid={`cancel-dismiss-unpublished-${dirName}`}
            onClick={() => setAsking(false)}
          >
            Cancel
          </Button>
        </Group>
      ) : (
        <Button
          ref={dismissRef}
          size="compact-xs"
          variant="default"
          style={{ flexShrink: 0 }}
          aria-label={`Dismiss the warning for ${name}`}
          data-testid={`dismiss-unpublished-${dirName}`}
          {...{ [DISMISS_UNPUBLISHED_ATTRIBUTE]: true }}
          onClick={() => setAsking(true)}
        >
          Dismiss
        </Button>
      )}
    </Group>
  )
}

/**
 * Branches merged before a submit finished, listed until an admin dismisses them or deletes the
 * branch: archiving leaves no retry or new submit to finish it. Names come from GitHub and are
 * attacker-chosen, so each is shown escaped.
 */
export function UnpublishedAtMergeAlert({
  branches,
  onDismiss,
}: {
  branches: readonly UnpublishedBranch[]
  onDismiss: (dirName: string) => Promise<void>
}) {
  const count = `${branches.length} ${branches.length === 1 ? 'branch' : 'branches'}`
  return (
    <Alert
      color="orange"
      icon={<IconAlertTriangle size={16} />}
      title={`${count} merged with an unfinished submit`}
      // The default clips focus rings at the edge, and scrolls sideways on Tab.
      styles={{ message: { overflow: 'visible' } }}
      data-testid="unpublished-at-merge-alert"
    >
      <Stack gap={4}>
        <Text size="sm">
          Merged on GitHub before the last submit finished, so commits from that submit may not be
          in the merge. They&apos;re still on this deployment&apos;s copy of the branch.
        </Text>
        <Text size="sm">
          Close System health and open the branch from &quot;{EDITOR_ACTIONS.switchBranch}…&quot;,
          where it&apos;s read-only, then compare it with the pull request. Make anything
          that&apos;s missing on a new branch, then use &quot;Dismiss&quot;.
        </Text>
        <Stack gap={4} mt={4}>
          {branches.map((branch) => (
            <UnpublishedRow key={branch.dirName} branch={branch} onDismiss={onDismiss} />
          ))}
        </Stack>
      </Stack>
    </Alert>
  )
}
