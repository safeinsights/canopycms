'use client'

/**
 * SystemHealthPanel - Admin-only modal surfacing the observability
 * endpoints from PR-A1..A4: task-queue/worker liveness (Overview), task
 * recovery (Tasks), and branch-directory recovery (Branches).
 *
 * Visibility is entirely the caller's responsibility -- Editor.tsx only
 * renders/opens this for admins (see isAdmin(userContext?.groups) there).
 * This component does not re-check that itself, same as GroupManager and
 * PermissionManager rely on their callers for that gate.
 */

import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Modal,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Spoiler,
  Stack,
  Table,
  Tabs,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core'
import { IconAlertCircle, IconAlertTriangle } from '@tabler/icons-react'
import { modals } from '@mantine/modals'
import {
  useSystemHealth,
  type UseSystemHealthReturn,
  type AdminTaskStatus,
  type DeletableTaskStatus,
} from './useSystemHealth'
import type { WorkerLiveness } from '../../api/admin'
import type { OperatingMode } from '../../operating-mode'
import type { Task, CorruptTaskFile } from '../../task-queue'
import type { BranchHealthEntry } from '../../branch-health'

// ============================================================================
// Small pure helpers
// ============================================================================

const PROVISIONING_LOCK_FRESH_MS = 5 * 60_000
const ORPHAN_YOUTH_THRESHOLD_MS = 15 * 60_000

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** Humanize a millisecond duration as e.g. "45s", "12m", "3h 5m", "2d 4h". */
function formatAgeMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const totalHours = Math.floor(totalMinutes / 60)
  if (totalHours < 24) return `${totalHours}h ${totalMinutes % 60}m`
  const totalDays = Math.floor(totalHours / 24)
  return `${totalDays}d ${totalHours % 24}h`
}

/**
 * [LOW-2] Whether the Purge button should be disabled for a corrupt-metadata
 * or orphan row, and the tooltip explaining why.
 * - Base branch: never purgeable -- the server already 400s
 *   ('The base branch directory can never be purged', see
 *   purgeBranchDirHandler in api/admin-branch-health.ts); this is UX
 *   honesty, not a new rail.
 * - Fresh provisioning lock: provisioning may genuinely be in progress
 *   (mirrors the server's [H1] freshness rail) -- applies to BOTH kinds,
 *   not just orphans.
 * - Orphan-only youth rail: a directory younger than
 *   ORPHAN_YOUTH_THRESHOLD_MS may still be a clone in progress that hasn't
 *   written branch.json yet. Corrupt-metadata dirs are exempt from this
 *   server-side (a parseable-then-corrupted file isn't a mid-clone
 *   signature), so they're exempt here too.
 */
function purgeGateFor(entry: BranchHealthEntry): { disabled: boolean; tooltip?: string } {
  if (entry.isBaseBranch) {
    return { disabled: true, tooltip: 'The base branch can never be purged' }
  }
  const lockFresh =
    !!entry.provisioningLock && entry.provisioningLock.ageMs < PROVISIONING_LOCK_FRESH_MS
  if (entry.kind === 'orphan') {
    const tooYoung = (entry.ageMs ?? 0) < ORPHAN_YOUTH_THRESHOLD_MS
    const disabled = lockFresh || tooYoung
    return { disabled, tooltip: disabled ? 'May be a clone in progress' : undefined }
  }
  return {
    disabled: lockFresh,
    tooltip: lockFresh ? 'Provisioning may be in progress' : undefined,
  }
}

function workerLivenessBadge(
  worker: WorkerLiveness,
  mode: OperatingMode,
): { color: string; label: string } {
  if (mode === 'dev') {
    return { color: 'gray', label: `Worker: ${worker.state}` }
  }
  switch (worker.state) {
    case 'alive':
      return { color: 'green', label: 'Worker: alive' }
    case 'stale':
      return { color: 'yellow', label: 'Worker: stale (possible crash)' }
    case 'absent':
    default:
      return { color: 'red', label: 'Worker: absent' }
  }
}

// Mirrors BranchManager.tsx's statusColorMap -- kept local (not exported
// there) rather than shared, same tiny lookup either way.
const branchStatusColorMap: Record<string, string> = {
  editing: 'brand',
  submitted: 'green',
  approved: 'teal',
}

const TASK_STATUS_OPTIONS: { label: string; value: AdminTaskStatus }[] = [
  { label: 'Pending', value: 'pending' },
  { label: 'Processing', value: 'processing' },
  { label: 'Completed', value: 'completed' },
  { label: 'Failed', value: 'failed' },
  { label: 'Corrupt', value: 'corrupt' },
]
const TASK_STATUS_VALUES: readonly AdminTaskStatus[] = TASK_STATUS_OPTIONS.map((o) => o.value)
function isAdminTaskStatus(value: string): value is AdminTaskStatus {
  return (TASK_STATUS_VALUES as readonly string[]).includes(value)
}

// ============================================================================
// Confirm-modal copy (races/limitations these actions accept -- see
// api/admin.ts and api/admin-branch-health.ts's handler docstrings)
// ============================================================================

const RETRY_CONFIRM_TEXT =
  'Retrying may duplicate work if the task also runs another way; task actions are safe to run twice.'

function deleteConfirmText(status: AdminTaskStatus): string {
  if (status === 'pending') {
    return 'The worker may already have picked this task up — deleting now does not guarantee it never runs, and in rare cases it can still run after the next worker restart.'
  }
  return 'This permanently deletes the task file. This cannot be undone.'
}

const MARK_MERGED_CONFIRM_TEXT =
  'In production the server cannot verify the PR actually merged (no GitHub access from the API) — confirm the PR is merged on GitHub first.'

const REPAIR_CONFIRM_TEXT =
  "Recreates metadata with defaults: status becomes 'editing', you become the creator, branch ACLs are reset. The corrupt file is archived alongside for forensics."

const PURGE_CONFIRM_TEXT =
  'The directory is moved to a hidden trash name and kept for 30 days, then deleted. Any git work inside was never pushed and will be lost when the trash is swept.'

// ============================================================================
// Main component
// ============================================================================

export interface SystemHealthPanelProps {
  opened: boolean
  onClose: () => void
}

export function SystemHealthPanel({ opened, onClose }: SystemHealthPanelProps) {
  const health = useSystemHealth({ isOpen: opened })

  return (
    <Modal opened={opened} onClose={onClose} title="System health" size="xl">
      <Tabs defaultValue="overview">
        <Tabs.List>
          <Tabs.Tab value="overview">Overview</Tabs.Tab>
          <Tabs.Tab value="tasks">Tasks</Tabs.Tab>
          <Tabs.Tab value="branches">Branches</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="overview" pt="md">
          <OverviewTab health={health} />
        </Tabs.Panel>
        <Tabs.Panel value="tasks" pt="md">
          <TasksTab health={health} />
        </Tabs.Panel>
        <Tabs.Panel value="branches" pt="md">
          <BranchesTab health={health} />
        </Tabs.Panel>
      </Tabs>
    </Modal>
  )
}

// ============================================================================
// Overview tab
// ============================================================================

function OverviewTab({ health }: { health: UseSystemHealthReturn }) {
  const { status, statusLoading, isRecentFatalError, error, refresh } = health

  if (!status && statusLoading) {
    return (
      <Group justify="center" py="xl">
        <Loader size="md" />
        <Text size="sm" c="dimmed">
          Loading status...
        </Text>
      </Group>
    )
  }

  if (!status) {
    return (
      <Stack align="center" py="xl" gap="sm">
        <Text size="sm" c="dimmed">
          No status available.
        </Text>
        <Button size="xs" variant="light" onClick={() => refresh()}>
          Refresh
        </Button>
      </Stack>
    )
  }

  const liveness = workerLivenessBadge(status.worker, status.mode)
  const lastFatalError = status.workerStatus?.lastFatalError
  const lastGitSync = status.workerStatus?.lastGitSync

  return (
    <Stack gap="md">
      {error && (
        <Alert color="red" icon={<IconAlertCircle size={16} />} variant="light">
          {error}
        </Alert>
      )}

      <Group gap="sm">
        <Badge color={liveness.color} variant="light" size="lg">
          {liveness.label}
        </Badge>
        {status.mode === 'dev' && (
          <Text size="xs" c="dimmed">
            No worker runs in dev mode
          </Text>
        )}
      </Group>

      {isRecentFatalError && lastFatalError && (
        <Alert color="red" icon={<IconAlertCircle size={16} />} title="Worker crash detected">
          <Text size="sm">{lastFatalError.message}</Text>
          <Text size="xs" c="dimmed" mt={4}>
            at {lastFatalError.at} ({lastFatalError.phase})
          </Text>
        </Alert>
      )}

      {status.statusReadError && (
        <Text size="xs" c="orange">
          Warning: could not read worker status ({status.statusReadError})
        </Text>
      )}

      {status.workerStatus?.lastGitSyncError && (
        <Alert color="orange" icon={<IconAlertCircle size={16} />} title="Last git sync failed">
          <Text size="sm">{status.workerStatus.lastGitSyncError.message}</Text>
          <Text size="xs" c="dimmed" mt={4}>
            at {status.workerStatus.lastGitSyncError.at}
          </Text>
        </Alert>
      )}

      {lastGitSync && (
        <Paper withBorder p="sm" radius="md">
          <Text size="sm" fw={600}>
            Last git sync
          </Text>
          <Text size="xs" c="dimmed">
            {status.workerStatus?.lastGitSyncAt ?? 'unknown time'} · {lastGitSync.durationMs}ms ·{' '}
            {lastGitSync.rebased.length} rebased · {lastGitSync.skippedDirty.length} skipped (dirty)
          </Text>
          {lastGitSync.failed.length > 0 && (
            <Spoiler
              maxHeight={0}
              showLabel={`${lastGitSync.failed.length} failed — show details`}
              hideLabel="Hide"
            >
              <Stack gap={4} mt={4}>
                {lastGitSync.failed.map((f) => (
                  <Text size="xs" c="red" key={f.branch}>
                    {f.branch}: {f.error}
                  </Text>
                ))}
              </Stack>
            </Spoiler>
          )}
        </Paper>
      )}

      <SimpleGrid cols={5} spacing="xs">
        {(['pending', 'processing', 'completed', 'failed', 'corrupt'] as const).map((key) => (
          <Paper key={key} withBorder p="xs" radius="md" ta="center">
            <Text size="xs" c="dimmed" tt="capitalize">
              {key}
            </Text>
            <Text
              size="lg"
              fw={700}
              c={
                (key === 'failed' || key === 'corrupt') && status.queue[key] > 0 ? 'red' : undefined
              }
            >
              {status.queue[key]}
            </Text>
          </Paper>
        ))}
      </SimpleGrid>
      {status.queue.oldestPendingAgeMs !== undefined && (
        <Text size="xs" c="dimmed">
          Oldest pending task: {formatAgeMs(status.queue.oldestPendingAgeMs)} old
        </Text>
      )}

      <Group justify="space-between" align="center">
        <Text size="xs" c="dimmed">
          Generated at {status.generatedAt}
        </Text>
        <Button size="xs" variant="light" onClick={() => refresh()} loading={statusLoading}>
          Refresh
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        Data may lag up to ~60s (shared-filesystem caching)
      </Text>
    </Stack>
  )
}

// ============================================================================
// Tasks tab
// ============================================================================

function TasksTab({ health }: { health: UseSystemHealthReturn }) {
  const { taskStatus, setTaskStatus, tasks, tasksLoading } = health
  const isCorrupt = taskStatus === 'corrupt'
  const taskRows: Task[] = tasks?.tasks ?? []
  const corruptRows: CorruptTaskFile[] = tasks?.corruptFiles ?? []
  const isEmpty = isCorrupt ? corruptRows.length === 0 : taskRows.length === 0
  const canDelete = taskStatus === 'pending' || taskStatus === 'failed' || taskStatus === 'corrupt'

  const handleRetryClick = (task: Task) => {
    modals.openConfirmModal({
      title: 'Retry task',
      children: <Text size="sm">{RETRY_CONFIRM_TEXT}</Text>,
      labels: { confirm: 'Retry', cancel: 'Cancel' },
      confirmProps: { color: 'brand' },
      onConfirm: () => health.retryTask(task.id),
    })
  }

  const handleDeleteClick = (status: DeletableTaskStatus, fileName: string) => {
    modals.openConfirmModal({
      title: 'Delete task file',
      children: <Text size="sm">{deleteConfirmText(status)}</Text>,
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => health.deleteTask(status, fileName),
    })
  }

  return (
    <Stack gap="md">
      <SegmentedControl
        data={TASK_STATUS_OPTIONS}
        value={taskStatus}
        onChange={(value) => {
          if (isAdminTaskStatus(value)) setTaskStatus(value)
        }}
      />

      {tasksLoading && taskRows.length === 0 && corruptRows.length === 0 ? (
        <Group justify="center" py="xl">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">
            Loading tasks...
          </Text>
        </Group>
      ) : isEmpty ? (
        <Text size="sm" c="dimmed" py="md">
          No {taskStatus} tasks.
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={600}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                {isCorrupt ? (
                  <>
                    <Table.Th>File</Table.Th>
                    <Table.Th>Size</Table.Th>
                    <Table.Th>Modified</Table.Th>
                    <Table.Th>Raw snippet</Table.Th>
                    <Table.Th>Actions</Table.Th>
                  </>
                ) : (
                  <>
                    <Table.Th>ID</Table.Th>
                    <Table.Th>Action</Table.Th>
                    <Table.Th>Created</Table.Th>
                    <Table.Th>Retries</Table.Th>
                    <Table.Th>Error</Table.Th>
                    <Table.Th>Actions</Table.Th>
                  </>
                )}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {isCorrupt
                ? corruptRows.map((file) => (
                    <Table.Tr key={file.fileName}>
                      <Table.Td>
                        <span title={file.fileName}>{truncate(file.fileName, 30)}</span>
                      </Table.Td>
                      <Table.Td>{file.size} bytes</Table.Td>
                      <Table.Td>{file.mtime}</Table.Td>
                      <Table.Td>
                        <Code block style={{ maxWidth: 320, whiteSpace: 'pre-wrap' }}>
                          {file.rawSnippet}
                        </Code>
                      </Table.Td>
                      <Table.Td>
                        <Button
                          size="xs"
                          variant="light"
                          color="red"
                          data-testid={`delete-task-${file.fileName}`}
                          onClick={() => handleDeleteClick('corrupt', file.fileName)}
                        >
                          Delete
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))
                : taskRows.map((task) => (
                    <Table.Tr key={task.id}>
                      <Table.Td>
                        <span title={task.id}>{truncate(task.id, 12)}</span>
                      </Table.Td>
                      <Table.Td>{task.action}</Table.Td>
                      <Table.Td>{task.createdAt}</Table.Td>
                      <Table.Td>{task.retryCount ?? 0}</Table.Td>
                      <Table.Td>
                        {task.error ? (
                          <Tooltip label={task.error} multiline maw={400}>
                            <Text size="xs" style={{ cursor: 'help' }}>
                              {truncate(task.error, 50)}
                            </Text>
                          </Tooltip>
                        ) : (
                          <Text size="xs" c="dimmed">
                            —
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Group gap="xs">
                          {taskStatus === 'failed' && (
                            <Button
                              size="xs"
                              variant="light"
                              data-testid={`retry-task-${task.id}`}
                              onClick={() => handleRetryClick(task)}
                            >
                              Retry
                            </Button>
                          )}
                          {canDelete && (
                            <Button
                              size="xs"
                              variant="light"
                              color="red"
                              data-testid={`delete-task-${task.id}`}
                              onClick={() =>
                                handleDeleteClick(
                                  taskStatus as DeletableTaskStatus,
                                  `${task.id}.json`,
                                )
                              }
                            >
                              Delete
                            </Button>
                          )}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Stack>
  )
}

// ============================================================================
// Branches tab
// ============================================================================

function BranchesTab({ health }: { health: UseSystemHealthReturn }) {
  const { branchHealth, branchHealthLoading } = health
  const entries = branchHealth?.entries ?? []

  const handleMarkMergedClick = (branchName: string) => {
    modals.openConfirmModal({
      title: 'Mark branch as merged',
      children: <Text size="sm">{MARK_MERGED_CONFIRM_TEXT}</Text>,
      labels: { confirm: 'Mark merged', cancel: 'Cancel' },
      confirmProps: { color: 'brand' },
      onConfirm: () => health.markMerged(branchName),
    })
  }

  const handleRepairClick = (dirName: string) => {
    modals.openConfirmModal({
      title: 'Repair metadata',
      children: <Text size="sm">{REPAIR_CONFIRM_TEXT}</Text>,
      labels: { confirm: 'Repair', cancel: 'Cancel' },
      confirmProps: { color: 'brand' },
      onConfirm: () => health.repairDir(dirName),
    })
  }

  const handlePurgeClick = (dirName: string) => {
    modals.openConfirmModal({
      title: 'Purge directory',
      children: <Text size="sm">{PURGE_CONFIRM_TEXT}</Text>,
      labels: { confirm: 'Purge', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => health.purgeDir(dirName),
    })
  }

  if (branchHealthLoading && entries.length === 0) {
    return (
      <Group justify="center" py="xl">
        <Loader size="sm" />
        <Text size="sm" c="dimmed">
          Loading branch health...
        </Text>
      </Group>
    )
  }

  if (entries.length === 0) {
    return (
      <Text size="sm" c="dimmed" py="md">
        No branch directories found.
      </Text>
    )
  }

  return (
    <Table.ScrollContainer minWidth={700}>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>PR</Table.Th>
            <Table.Th>Sync</Table.Th>
            <Table.Th>Warnings</Table.Th>
            <Table.Th>Updated</Table.Th>
            <Table.Th>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {entries.map((entry) => (
            <BranchHealthRow
              key={entry.dirName}
              entry={entry}
              onMarkMerged={handleMarkMergedClick}
              onRepair={handleRepairClick}
              onPurge={handlePurgeClick}
            />
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  )
}

function BranchHealthRow({
  entry,
  onMarkMerged,
  onRepair,
  onPurge,
}: {
  entry: BranchHealthEntry
  onMarkMerged: (branchName: string) => void
  onRepair: (dirName: string) => void
  onPurge: (dirName: string) => void
}) {
  if (entry.kind === 'healthy' && entry.branch) {
    const b = entry.branch
    // [LOW-3] Mirror rebaseActiveBranches' skip logic (worker/cms-worker.ts):
    // the worker rebases every branch except 'submitted'/'approved' (under an
    // active PR) and 'archived' (already merged). Stated as an exclusion list
    // rather than `status === 'editing'` so that a status added later shows its
    // rebase failures by default instead of silently hiding them -- the bug
    // this replaced.
    const showRebaseFailure =
      !['submitted', 'approved', 'archived'].includes(b.status) && !!b.rebaseFailure
    const canMarkMerged =
      (b.status === 'submitted' || b.status === 'approved') && !!b.pullRequestNumber

    return (
      <Table.Tr>
        <Table.Td>
          <Group gap={4} wrap="nowrap">
            <Text size="sm">{entry.dirName}</Text>
            {entry.isBaseBranch && (
              <Badge size="xs" color="gray" variant="outline">
                base
              </Badge>
            )}
          </Group>
        </Table.Td>
        <Table.Td>
          <Badge color={branchStatusColorMap[b.status] ?? 'neutral'} variant="light">
            {b.status}
          </Badge>
        </Table.Td>
        <Table.Td>
          {b.pullRequestNumber ? (
            <Text
              size="xs"
              c="blue"
              component="a"
              href={b.pullRequestUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: 'underline' }}
            >
              PR #{b.pullRequestNumber}
              {b.pullRequestState ? ` (${b.pullRequestState})` : ''}
            </Text>
          ) : (
            <Text size="xs" c="dimmed">
              —
            </Text>
          )}
        </Table.Td>
        <Table.Td>
          {b.syncStatus === 'sync-failed' ? (
            <Tooltip
              label={
                b.syncFailureReason
                  ? `${b.syncFailureReason} — retry from the Tasks tab`
                  : 'GitHub sync failed — retry from the Tasks tab'
              }
              multiline
              maw={320}
            >
              <Badge color="red" variant="light">
                sync-failed
              </Badge>
            </Tooltip>
          ) : b.syncStatus === 'pending-sync' ? (
            <Badge color="gray" variant="light">
              pending-sync
            </Badge>
          ) : null}
        </Table.Td>
        <Table.Td>
          <Group gap={6} wrap="nowrap">
            {!!b.conflictFiles?.length && (
              <Badge color="orange" variant="light">
                {b.conflictFiles.length} conflict{b.conflictFiles.length === 1 ? '' : 's'}
              </Badge>
            )}
            {showRebaseFailure && b.rebaseFailure && (
              <Tooltip
                label={`${b.rebaseFailure.message} (failing since ${b.rebaseFailure.firstAt})`}
                multiline
                maw={320}
              >
                <ThemeIcon
                  color="yellow"
                  variant="light"
                  size="sm"
                  radius="xl"
                  data-testid={`rebase-failure-${entry.dirName}`}
                >
                  <IconAlertTriangle size={12} />
                </ThemeIcon>
              </Tooltip>
            )}
          </Group>
        </Table.Td>
        <Table.Td>
          <Text size="xs" c="dimmed">
            {b.updatedAt}
          </Text>
        </Table.Td>
        <Table.Td>
          {canMarkMerged && (
            <Button
              size="xs"
              variant="light"
              data-testid={`mark-merged-${b.name}`}
              onClick={() => onMarkMerged(b.name)}
            >
              Mark merged
            </Button>
          )}
        </Table.Td>
      </Table.Tr>
    )
  }

  if (entry.kind === 'corrupt-metadata') {
    const purgeGate = purgeGateFor(entry)
    return (
      <Table.Tr style={{ backgroundColor: 'var(--mantine-color-red-light)' }}>
        <Table.Td>{entry.dirName}</Table.Td>
        <Table.Td>
          <Badge color="red" variant="light">
            corrupt metadata
          </Badge>
        </Table.Td>
        <Table.Td colSpan={3}>
          <Tooltip label={entry.parseError} multiline maw={400}>
            <Text size="xs" c="red">
              {truncate(entry.parseError ?? 'Unknown parse error', 60)}
            </Text>
          </Tooltip>
        </Table.Td>
        <Table.Td>
          <Text size="xs" c="dimmed">
            {entry.metaMtime ?? '—'}
          </Text>
        </Table.Td>
        <Table.Td>
          <Group gap="xs" wrap="nowrap">
            <Button
              size="xs"
              variant="light"
              data-testid={`repair-dir-${entry.dirName}`}
              onClick={() => onRepair(entry.dirName)}
            >
              Repair
            </Button>
            <Tooltip label={purgeGate.tooltip} disabled={!purgeGate.disabled}>
              <span>
                <Button
                  size="xs"
                  variant="light"
                  color="red"
                  disabled={purgeGate.disabled}
                  data-testid={`purge-dir-${entry.dirName}`}
                  onClick={() => onPurge(entry.dirName)}
                >
                  Purge
                </Button>
              </span>
            </Tooltip>
          </Group>
        </Table.Td>
      </Table.Tr>
    )
  }

  // orphan
  const purgeGate = purgeGateFor(entry)

  return (
    <Table.Tr style={{ opacity: 0.65 }}>
      <Table.Td>{entry.dirName}</Table.Td>
      <Table.Td>
        <Badge color="gray" variant="outline">
          orphan
        </Badge>
      </Table.Td>
      <Table.Td colSpan={3}>
        <Text size="xs" c="dimmed">
          {entry.ageMs !== undefined ? `${formatAgeMs(entry.ageMs)} old` : 'unknown age'} ·{' '}
          {entry.hasGitDir ? 'has .git' : 'no .git'}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="xs" c="dimmed">
          {entry.dirMtime ?? '—'}
        </Text>
      </Table.Td>
      <Table.Td>
        <Tooltip label={purgeGate.tooltip} disabled={!purgeGate.disabled}>
          <span>
            <Button
              size="xs"
              variant="light"
              color="red"
              disabled={purgeGate.disabled}
              data-testid={`purge-dir-${entry.dirName}`}
              onClick={() => onPurge(entry.dirName)}
            >
              Purge
            </Button>
          </span>
        </Tooltip>
      </Table.Td>
    </Table.Tr>
  )
}
