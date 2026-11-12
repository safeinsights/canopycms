'use client'

import type React from 'react'
import { Alert, Code, Group, Stack, Text } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'
import type { ConflictsStatusFailure } from '../../types'
import { escapeForLog } from '../../utils/escape-text'
import { RelativeTime } from '../components/RelativeTime'

const WHY: Record<ConflictsStatusFailure['reason'], React.ReactNode> = {
  permission: (
    <>
      GitHub refused it: the GitHub App lacks the &quot;Commit statuses&quot; permission. An owner
      of the account the App is installed on accepts the App&apos;s request for it in the
      installation&apos;s settings on GitHub, and <Code>canopycms init-github-app verify</Code> then
      confirms it. A fine-grained token needs &quot;Commit statuses: read and write&quot; instead.
    </>
  ),
  unreachable: "GitHub couldn't be reached. The next git sync tries again.",
  other: 'GitHub refused it. The next git sync tries again.',
}

/**
 * The last git sync could not set the "CanopyCMS conflicts" status on some pull requests
 * (worker/conflicts-status.ts). Pushes and pull request updates are unaffected.
 */
export function ConflictsStatusAlert({ failure }: { failure: ConflictsStatusFailure }) {
  const unlisted = failure.count - failure.branches.length
  return (
    <Alert
      color="orange"
      icon={<IconAlertTriangle size={16} />}
      title="Conflicts status not set on GitHub"
      data-testid="conflicts-status-alert"
    >
      <Stack gap={4}>
        <Text size="sm">
          The &quot;CanopyCMS conflicts&quot; check on the pull request of each branch below
          wasn&apos;t updated, so a required check waits on it. {WHY[failure.reason]}
        </Text>
        <Text size="xs" c="dimmed">
          {escapeForLog(failure.message)}
        </Text>
        <Group gap={4}>
          {failure.branches.map((name) => (
            <Code key={name}>{escapeForLog(name)}</Code>
          ))}
        </Group>
        {unlisted > 0 && <Text size="sm">And {unlisted} more.</Text>}
        <RelativeTime iso={failure.at} prefix="Last tried " size="xs" c="dimmed" />
      </Stack>
    </Alert>
  )
}
