import React from 'react'

import { Badge, Button, Group, Paper, ScrollArea, Stack, Text, Title } from '@mantine/core'
import type { BranchMode } from '../paths'

export interface BranchSummary {
  name: string
  status: string
  createdBy?: string
  updatedAt?: string
  access?: {
    users?: string[]
    groups?: string[]
  }
  pullRequestUrl?: string
  pullRequestNumber?: number
  commentCount?: number
}

const statusColorMap: Record<string, { color: string; variant?: 'light' | 'filled' }> = {
  editing: { color: 'brand', variant: 'light' },
  submitted: { color: 'green', variant: 'light' },
  locked: { color: 'yellow', variant: 'light' },
}

export interface BranchManagerProps {
  branches: BranchSummary[]
  mode?: BranchMode
  onSelect?: (name: string) => void
  onDelete?: (name: string) => void
  onSubmit?: (name: string) => void
  onWithdraw?: (name: string) => void
  onRequestChanges?: (name: string) => void
  onClose?: () => void
}

export const BranchManager: React.FC<BranchManagerProps> = ({
  branches,
  mode,
  onSelect,
  onDelete,
  onSubmit,
  onWithdraw,
  onRequestChanges,
  onClose,
}) => {
  const isLocalSimple = mode === 'local-simple'
  return (
    <Paper
      withBorder
      radius="md"
      shadow="sm"
      h="100%"
      style={{ display: 'flex', flexDirection: 'column' }}
    >
      <Group justify="space-between" px="md" py="sm">
        <div>
          <Title order={4}>Branches</Title>
          <Text size="xs" c="dimmed">
            Manage access, status, and lifecycle
          </Text>
        </div>
        <Button variant="subtle" color="neutral" size="xs" onClick={onClose}>
          Close
        </Button>
      </Group>
      <ScrollArea style={{ flex: 1 }} px="md" pb="md">
        {branches.length === 0 ? (
          <Text size="sm" c="dimmed" py="md">
            {isLocalSimple
              ? 'Branch management is disabled in local-simple mode.'
              : 'No branches available.'}
          </Text>
        ) : (
          <Stack gap="sm">
            {branches.map((b) => {
              const statusColor = statusColorMap[b.status] ?? {
                color: 'neutral',
                variant: 'light' as const,
              }
              return (
                <Paper key={b.name} withBorder radius="md" p="md" shadow="xs">
                  <Group justify="space-between" align="flex-start">
                    <Stack gap={4}>
                      <Group gap="xs">
                        <Text fw={600}>{b.name}</Text>
                        <Badge color={statusColor.color} variant={statusColor.variant}>
                          {b.status}
                        </Badge>
                        {b.pullRequestNumber && (
                          <Badge color="blue" variant="light">
                            PR #{b.pullRequestNumber}
                          </Badge>
                        )}
                        {b.commentCount !== undefined && b.commentCount > 0 && (
                          <Badge color="grape" variant="light">
                            {b.commentCount} {b.commentCount === 1 ? 'comment' : 'comments'}
                          </Badge>
                        )}
                      </Group>
                      <Group gap="xs" align="center">
                        <Text size="xs" c="dimmed">
                          {b.updatedAt ? `Updated ${b.updatedAt}` : ''}
                          {b.createdBy ? ` • Owner: ${b.createdBy}` : ''}
                        </Text>
                        {b.pullRequestUrl && (
                          <>
                            <Text size="xs" c="dimmed">
                              •
                            </Text>
                            <Text
                              size="xs"
                              c="blue"
                              component="a"
                              href={b.pullRequestUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ textDecoration: 'underline', cursor: 'pointer' }}
                            >
                              View PR
                            </Text>
                          </>
                        )}
                      </Group>
                      {b.access && (
                        <Group gap={6}>
                          {b.access.users?.map((u) => (
                            <Badge key={u} variant="outline" color="neutral">
                              {u}
                            </Badge>
                          ))}
                          {b.access.groups?.map((g) => (
                            <Badge key={g} variant="outline" color="neutral">
                              {g}
                            </Badge>
                          ))}
                        </Group>
                      )}
                    </Stack>
                    <Group gap={8}>
                      <Button size="xs" variant="light" onClick={() => onSelect?.(b.name)}>
                        Open
                      </Button>
                      {b.status === 'submitted' ? (
                        <Button
                          size="xs"
                          variant="light"
                          color="orange"
                          onClick={() => onWithdraw?.(b.name)}
                        >
                          Withdraw
                        </Button>
                      ) : (
                        <Button
                          size="xs"
                          variant="light"
                          color="green"
                          onClick={() => onSubmit?.(b.name)}
                        >
                          Submit
                        </Button>
                      )}
                      <Button
                        size="xs"
                        variant="outline"
                        color="neutral"
                        onClick={() => onRequestChanges?.(b.name)}
                      >
                        Request changes
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        color="red"
                        onClick={() => onDelete?.(b.name)}
                      >
                        Delete
                      </Button>
                    </Group>
                  </Group>
                </Paper>
              )
            })}
          </Stack>
        )}
      </ScrollArea>
    </Paper>
  )
}
