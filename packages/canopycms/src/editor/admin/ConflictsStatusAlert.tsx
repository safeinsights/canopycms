'use client'

import type React from 'react'
import { Alert, Code, Group, List, Stack, Text } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'
import type { ConflictsStatusFailure } from '../../types'
import { escapeForLog } from '../../utils/escape-text'
import { RelativeTime } from '../components/RelativeTime'

/** A long unbroken name wraps inside the alert rather than widening it. */
const WRAP = { overflowWrap: 'anywhere' } as const

const WHY: Record<ConflictsStatusFailure['reason'], React.ReactNode> = {
  permission: (
    <>
      <Text size="sm">
        GitHub refused it: the worker&apos;s GitHub credential lacks the &quot;Commit statuses&quot;
        permission.
      </Text>
      <List size="sm" spacing={2}>
        <List.Item>
          A GitHub App: its owner adds &quot;Commit statuses: read and write&quot; in the App&apos;s
          permissions on GitHub, then an owner of the account it is installed on accepts the request
          in the installation&apos;s settings.{' '}
          <Code style={{ whiteSpace: 'nowrap' }}>canopycms init-github-app verify</Code> confirms
          it.
        </List.Item>
        <List.Item>
          A fine-grained token: give it &quot;Commit statuses: read and write&quot;. A classic
          token&apos;s repo scope already has it.
        </List.Item>
      </List>
    </>
  ),
  unreachable: (
    <Text size="sm">
      GitHub couldn&apos;t be reached, or was busy. The next git sync tries again.
    </Text>
  ),
  other: (
    <Text size="sm">
      GitHub refused it. The next git sync tries again; if it keeps failing, the worker log names
      each pull request and GitHub&apos;s answer.
    </Text>
  ),
}

/**
 * The last git sync could not set the "CanopyCMS conflicts" status on some pull requests
 * (worker/conflicts-status.ts).
 */
export function ConflictsStatusAlert({ failure }: { failure: ConflictsStatusFailure }) {
  const unlisted = failure.count - failure.branches.length
  const pullRequests = `${failure.count} pull request${failure.count === 1 ? '' : 's'}`
  return (
    <Alert
      color="orange"
      icon={<IconAlertTriangle size={16} />}
      title={`Conflicts status not set on ${pullRequests}`}
      data-testid="conflicts-status-alert"
    >
      <Stack gap={4}>
        <Text size="sm">
          The &quot;CanopyCMS conflicts&quot; check on the pull request of each branch below keeps
          its last result, or has none yet. Where it is a required check, merging waits on it.
          Saving, submitting and pull request updates are unaffected.
        </Text>
        {WHY[failure.reason]}
        <Group gap={4}>
          {failure.branches.map((name) => (
            <Code key={name} style={WRAP}>
              {escapeForLog(name)}
            </Code>
          ))}
        </Group>
        {unlisted > 0 && <Text size="sm">And {unlisted} more.</Text>}
        <Text size="xs" c="dimmed" style={WRAP}>
          The last error: &ldquo;{escapeForLog(failure.message)}&rdquo;
        </Text>
        <RelativeTime iso={failure.at} prefix="Last tried " size="xs" c="dimmed" />
      </Stack>
    </Alert>
  )
}
