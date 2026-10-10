'use client'

/**
 * SystemHealthPanel - Admin-only modal surfacing observability endpoints:
 * task-queue/worker liveness (Overview), task recovery (Tasks), and
 * branch-directory recovery (Branches).
 *
 * Visibility is the caller's responsibility: Editor.tsx renders/opens this
 * only for admins (see isAdmin(userContext?.groups)); this component does not
 * re-check that itself, same as GroupManager and PermissionManager.
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
import type { DuplicateContentId } from '../../content-id-index'
import type { OperatingMode } from '../../operating-mode'
import type { Task, CorruptTaskFile } from '../../task-queue'
import type { BranchHealthEntry, DuplicateIdScan } from '../../branch-health'
import type { BaseRefreshReport, BaseSchemaHold } from '../../types'

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
 * Whether the Purge button should be disabled for this row, and why (tooltip).
 * - Base branch: never purgeable — the server already 400s this (UX
 *   consistency, not a new rail); see purgeBranchDirHandler in
 *   api/admin-branch-health.ts.
 * - Fresh provisioning lock ([H1] freshness rail): provisioning may
 *   genuinely be in progress, for either row kind.
 * - Orphan-only youth rail: a directory younger than
 *   ORPHAN_YOUTH_THRESHOLD_MS may still be mid-clone, before branch.json is
 *   written. Corrupt-metadata dirs are exempt server-side too (a
 *   parseable-then-corrupted file isn't a mid-clone signature).
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
    tooltip: lockFresh
      ? 'Provisioning, or the worker syncing this branch, may be in progress'
      : undefined,
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

const BASE_REFRESH_LABELS: Record<BaseRefreshReport['outcome'], string> = {
  refreshed: 'fast-forwarded',
  'up-to-date': 'up to date',
  'skipped-dirty': 'refresh skipped (uncommitted changes)',
  'skipped-locked': 'refresh skipped (workspace busy: provisioning or an admin action)',
  'skipped-not-provisioned': 'not yet provisioned',
  failed: 'refresh failed',
}

/**
 * The worker holding the base branch for an editor deploy, or the cycle it stopped waiting.
 * The rule and its bound live in worker/schema-gate.ts.
 */
function BaseHoldAlert({ hold }: { hold: BaseSchemaHold }) {
  const names = hold.missingSchemas.map((name, i) => (
    <span key={name}>
      {i > 0 && ', '}
      <Code>{name}</Code>
    </span>
  ))
  const editor = hold.editorBuild.sourceRevision ? (
    <>
      the running editor (built from <Code>{hold.editorBuild.sourceRevision.slice(0, 12)}</Code>)
    </>
  ) : (
    'the running editor'
  )
  return (
    <Alert
      color={hold.expired ? 'orange' : 'blue'}
      icon={<IconAlertTriangle size={16} />}
      title={hold.expired ? 'Stopped waiting for the editor deploy' : 'Waiting for editor deploy'}
      data-testid="base-hold-alert"
    >
      <Text size="sm">
        Newly merged content names {names}, which {editor} does not define.{' '}
        {hold.expired
          ? 'The worker updated the base branch anyway; content types using them are unavailable until an editor image defining them is deployed.'
          : 'The worker keeps the base branch at its current version until an editor image defining them handles a request.'}
      </Text>
      <Text size="xs" c="dimmed" mt={4}>
        Held since {hold.since} · {hold.files.join(', ')}
        {hold.fileCount > hold.files.length && ` and ${hold.fileCount - hold.files.length} more`}
      </Text>
    </Alert>
  )
}

/**
 * Why the base branch needs an operator, or null when its last refresh needs
 * nothing. Shared by the overview and the base row's warning tooltip.
 */
function baseRefreshWarning(report: BaseRefreshReport | undefined): string | null {
  if (!report) return null
  const lines: string[] = []
  if (report.outcome === 'skipped-dirty' || report.outcome === 'failed') {
    lines.push(
      `Base branch ${BASE_REFRESH_LABELS[report.outcome]}${report.message ? `: ${report.message}` : ''}`,
    )
    if (report.dirtyFiles?.length) lines.push(`Uncommitted: ${report.dirtyFiles.join(', ')}`)
  }
  if (report.trackedCanopyMeta?.length) {
    lines.push(
      `The site repo tracks canopycms state (${report.trackedCanopyMeta.join(', ')}). ` +
        'Untrack it with `git rm -r --cached .canopy-meta`, add `.canopy-meta/` to .gitignore, and commit.',
    )
  }
  return lines.length > 0 ? lines.join('\n') : null
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

// Confirm-modal copy (races/limitations these actions accept -- see
// api/admin.ts and api/admin-branch-health.ts's handler docstrings)

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

const DUPLICATE_REPAIR_CONFIRM_TEXT =
  'These files share a content ID, so the editor uses only the one marked Keep. Archiving renames each other file to a hidden name in the same folder. Nothing is deleted.'

const DUPLICATE_REPAIR_EDITOR_NOTE =
  'This changes files on the branch, and adds you as one of its editors.'

/**
 * Why a healthy row's duplicate-ID state is unknown. `null` is a row the last
 * scan did not include.
 */
function duplicateUncheckedReason(scan: DuplicateIdScan | null): string {
  if (scan?.state === 'unknown' && scan.reason === 'failed') {
    return 'The duplicate ID check failed on this branch.'
  }
  if (scan?.state === 'unknown') {
    return 'The duplicate ID check ran out of time before this branch.'
  }
  return 'This branch was added after the last duplicate ID check.'
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : word.endsWith('h') ? 'es' : 's'}`
}

/**
 * One line for the whole Branches tab, so a scan that did not finish never
 * reads as a clean one: rows without a badge are clean only when this says so.
 */
function duplicateScanSummary(
  health: Pick<
    UseSystemHealthReturn,
    'duplicateIdScan' | 'duplicateIdScanLoading' | 'duplicateIdScanError'
  >,
  healthyDirNames: string[],
): { text: string; color: string } {
  const { duplicateIdScan: scan, duplicateIdScanLoading, duplicateIdScanError } = health
  if (duplicateIdScanLoading && !scan) {
    return { text: 'Checking for duplicate content IDs…', color: 'dimmed' }
  }
  if (duplicateIdScanError) {
    return {
      text: `Could not check for duplicate content IDs: ${duplicateIdScanError}`,
      color: 'orange',
    }
  }
  if (!scan) return { text: 'Duplicate content IDs not checked yet.', color: 'orange' }

  let found = 0
  let unchecked = 0
  for (const dirName of healthyDirNames) {
    const state = scan.byDir[dirName]?.state
    if (state === 'found') found++
    else if (state !== 'none') unchecked++
  }
  const parts: string[] = []
  if (found > 0) parts.push(`Duplicate content IDs found on ${plural(found, 'branch')}.`)
  if (unchecked > 0) parts.push(`Could not check ${plural(unchecked, 'branch')}.`)
  if (parts.length === 0) return { text: 'No duplicate content IDs found.', color: 'dimmed' }
  return { text: parts.join(' '), color: 'orange' }
}

const PURGE_CONFIRM_TEXT =
  'The directory is moved to a hidden trash name and kept for 30 days, then deleted. Any git work inside was never pushed and will be lost when the trash is swept.'

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
  const baseWarning = baseRefreshWarning(lastGitSync?.baseRefresh)
  const { build } = status
  // Absent for a worker that predates the field, which is not evidence of skew;
  // nor is a stale or absent worker's leftover status file, which names no running build.
  const workerVersion = status.workerStatus?.workerVersion || undefined
  const lastShutdown = status.workerStatus?.lastShutdown
  const versionSkew =
    status.worker.state === 'alive' &&
    workerVersion !== undefined &&
    workerVersion !== build.canopycmsVersion

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
        <Alert
          color="red"
          icon={<IconAlertCircle size={16} />}
          title={
            lastFatalError.phase === 'startup'
              ? 'The worker failed to start'
              : 'The worker stopped while running'
          }
        >
          <Text size="sm">{lastFatalError.message}</Text>
          <Text size="xs" c="dimmed" mt={4}>
            at {lastFatalError.at}
          </Text>
        </Alert>
      )}

      {status.settingsWorkspaceError && (
        <Alert
          color="red"
          icon={<IconAlertCircle size={16} />}
          title="Settings workspace unavailable: groups and path rules are not loading"
        >
          <Text size="sm">{status.settingsWorkspaceError}</Text>
        </Alert>
      )}

      {status.schemaIssues && status.schemaIssues.length > 0 && (
        <Alert
          color="yellow"
          icon={<IconAlertTriangle size={16} />}
          title="Content types this editor version doesn't know"
          data-testid="schema-issues-alert"
        >
          <Stack gap={4}>
            {status.schemaIssues.map((issue) => (
              <Text size="sm" key={`${issue.kind}:${issue.message}`}>
                {issue.kind === 'unknown-schema' ? (
                  <>
                    <Code>{issue.metaFile}</Code> names <Code>{issue.schemaRef}</Code>, so entry
                    type <Code>{issue.entryType}</Code> is unavailable
                  </>
                ) : (
                  issue.message
                )}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}

      {status.workerStatus?.baseHold && <BaseHoldAlert hold={status.workerStatus.baseHold} />}

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

      {versionSkew && (
        <Alert
          color="orange"
          icon={<IconAlertCircle size={16} />}
          title="API and worker versions differ"
          data-testid="version-skew-warning"
        >
          <Text size="sm">
            The API runs canopycms {build.canopycmsVersion} but the worker runs canopycms{' '}
            {workerVersion}. They were deployed from different builds.
          </Text>
        </Alert>
      )}

      <Paper withBorder p="sm" radius="md">
        <Text size="sm" fw={600}>
          Build
        </Text>
        <Text size="xs" c="dimmed" data-testid="build-api-version">
          API: canopycms {build.canopycmsVersion}
        </Text>
        <Text size="xs" c="dimmed" data-testid="build-source-revision">
          Source revision:{' '}
          {build.sourceRevision ? (
            <Tooltip label={build.sourceRevision}>
              <Code>{build.sourceRevision.slice(0, 12)}</Code>
            </Tooltip>
          ) : (
            'not set (pass the CANOPY_SOURCE_SHA build arg to the image build)'
          )}
        </Text>
        <Text size="xs" c="dimmed" data-testid="build-worker-version">
          Worker version: {workerVersion ? `canopycms ${workerVersion}` : 'unknown'}
        </Text>
        {lastShutdown && (
          <Text
            size="xs"
            c={lastShutdown.outcome === 'drained' ? 'dimmed' : 'orange'}
            data-testid="build-last-shutdown"
          >
            Last worker shutdown: {lastShutdown.reason} at {lastShutdown.at}
            {lastShutdown.outcome === 'deadline' &&
              ` · drain deadline hit, aborted ${lastShutdown.abandoned?.join(', ') ?? 'in-flight work'}`}
            {lastShutdown.outcome === 'drained' &&
              lastShutdown.drainMs !== undefined &&
              ` · drained in ${(lastShutdown.drainMs / 1000).toFixed(1)}s`}
            {lastShutdown.outcome === 'not-drained' && ' (a crash or a forced stop)'}
          </Text>
        )}
        {lastFatalError?.phase === 'startup' && (
          <Text size="xs" c="orange" data-testid="build-failed-start">
            Last start failed at {lastFatalError.at}
          </Text>
        )}
        <Text size="xs" c="dimmed" data-testid="build-media">
          Media storage:{' '}
          {status.assetStore.configured ? 'configured' : 'not configured — uploads are disabled'}
        </Text>
        <Text
          size="xs"
          c={status.imageProcessing.available ? 'dimmed' : 'orange'}
          data-testid="build-image-processing"
        >
          Image processing:{' '}
          {status.imageProcessing.available
            ? 'available'
            : `unavailable — new editor image sizes and crops fail, and uploads skip decode validation${
                status.imageProcessing.error ? ` (${status.imageProcessing.error})` : ''
              }`}
        </Text>
      </Paper>

      {lastGitSync && (
        <Paper withBorder p="sm" radius="md">
          <Text size="sm" fw={600}>
            Last git sync
          </Text>
          <Text size="xs" c="dimmed">
            {status.workerStatus?.lastGitSyncAt ?? 'unknown time'} · {lastGitSync.durationMs}ms ·{' '}
            {lastGitSync.rebased.length} rebased · {lastGitSync.skippedDirty.length} skipped (dirty)
            {/* Optional: a worker predating the field writes none, so only
                render it when present. */}
            {lastGitSync.skippedLocked && lastGitSync.skippedLocked.length > 0
              ? ` · ${lastGitSync.skippedLocked.length} skipped (busy: a content write, provisioning or purge)`
              : ''}
          </Text>
          {/* Optional: a worker predating the base-refresh report writes none. */}
          {lastGitSync.baseRefresh && (
            <Text size="xs" c="dimmed" data-testid="base-refresh-outcome">
              Base branch: {BASE_REFRESH_LABELS[lastGitSync.baseRefresh.outcome]}
            </Text>
          )}
          {baseWarning && (
            <Text
              size="xs"
              c="orange"
              style={{ whiteSpace: 'pre-line' }}
              data-testid="base-refresh-warning"
            >
              {baseWarning}
            </Text>
          )}
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

function BranchesTab({ health }: { health: UseSystemHealthReturn }) {
  const { branchHealth, branchHealthLoading } = health
  const entries = branchHealth?.entries ?? []
  const baseWarning = baseRefreshWarning(health.status?.workerStatus?.lastGitSync?.baseRefresh)

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

  // Its own dialog, reachable only from the duplicate badge, whose confirm
  // calls only the duplicate repair: Purge sits on neighbouring rows and
  // trashes a whole branch directory.
  const handleDuplicateIdsClick = (dirName: string, duplicates: DuplicateContentId[]) => {
    modals.openConfirmModal({
      title: 'Fix duplicate content IDs',
      children: <DuplicateRepairDetails dirName={dirName} duplicates={duplicates} />,
      labels: { confirm: 'Archive duplicates', cancel: 'Cancel' },
      confirmProps: { color: 'orange' },
      onConfirm: () => health.repairDuplicateIds(dirName),
    })
  }

  const healthyDirNames = entries.filter((e) => e.kind === 'healthy').map((e) => e.dirName)
  const duplicateSummary = duplicateScanSummary(health, healthyDirNames)

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
    <Stack gap="xs">
      <Group justify="space-between" align="center" wrap="nowrap">
        <Text size="xs" c={duplicateSummary.color} data-testid="duplicate-id-summary">
          {duplicateSummary.text}
        </Text>
        <Button
          size="compact-xs"
          variant="subtle"
          loading={health.duplicateIdScanLoading}
          onClick={() => health.checkDuplicateIds()}
        >
          Check again
        </Button>
      </Group>
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
                baseWarning={entry.isBaseBranch ? baseWarning : null}
                duplicateIdScan={
                  health.duplicateIdScan
                    ? (health.duplicateIdScan.byDir[entry.dirName] ?? null)
                    : undefined
                }
                onMarkMerged={handleMarkMergedClick}
                onRepair={handleRepairClick}
                onPurge={handlePurgeClick}
                onDuplicateIds={handleDuplicateIdsClick}
              />
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  )
}

function DuplicateRepairDetails({
  dirName,
  duplicates,
}: {
  dirName: string
  duplicates: DuplicateContentId[]
}) {
  return (
    <Stack gap="sm">
      <Text size="sm">
        Branch <Code>{dirName}</Code>
      </Text>
      <Text size="sm">{DUPLICATE_REPAIR_CONFIRM_TEXT}</Text>
      {duplicates.map((d) => (
        <Paper key={d.id} withBorder p="xs" radius="sm" data-testid={`duplicate-id-${d.id}`}>
          <Text size="xs" fw={600}>
            Content ID <Code>{d.id}</Code>
          </Text>
          <Text size="xs">
            Keep: <Code>{d.keptPath}</Code>
          </Text>
          {d.droppedPaths.map((p) => (
            <Text size="xs" key={p}>
              Archive: <Code>{p}</Code>
            </Text>
          ))}
        </Paper>
      ))}
      <Text size="xs" c="dimmed">
        {DUPLICATE_REPAIR_EDITOR_NOTE}
      </Text>
    </Stack>
  )
}

function BranchHealthRow({
  entry,
  baseWarning,
  duplicateIdScan,
  onMarkMerged,
  onRepair,
  onPurge,
  onDuplicateIds,
}: {
  entry: BranchHealthEntry
  /** The base branch's last refresh problem, from worker status; null on other rows. */
  baseWarning: string | null
  /**
   * This row's result from the last duplicate-ID scan: `undefined` when there
   * is no scan result (none yet, or the last request failed; the tab summary
   * says which), `null` when the scan did not include this row.
   */
  duplicateIdScan: DuplicateIdScan | null | undefined
  onMarkMerged: (branchName: string) => void
  onRepair: (dirName: string) => void
  onPurge: (dirName: string) => void
  onDuplicateIds: (dirName: string, duplicates: DuplicateContentId[]) => void
}) {
  if (entry.kind === 'healthy' && entry.branch) {
    const b = entry.branch
    // Mirrors the rebase loop's skip logic (worker/rebase.ts): the worker
    // rebases every branch except 'submitted'/'approved' (under an active PR)
    // and 'archived' (already merged). An exclusion list, not `status ===
    // 'editing'`, so a status added later still shows its rebase failures by
    // default instead of silently hiding them.
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
            {baseWarning && (
              <Tooltip label={baseWarning} multiline maw={420} style={{ whiteSpace: 'pre-line' }}>
                <ThemeIcon
                  color="yellow"
                  variant="light"
                  size="sm"
                  radius="xl"
                  data-testid={`base-refresh-warning-${entry.dirName}`}
                >
                  <IconAlertTriangle size={12} />
                </ThemeIcon>
              </Tooltip>
            )}
            {duplicateIdScan?.state === 'found' && (
              <Tooltip label="Review and fix">
                <Badge
                  component="button"
                  type="button"
                  color="orange"
                  variant="light"
                  style={{ cursor: 'pointer' }}
                  data-testid={`duplicate-content-ids-${entry.dirName}`}
                  onClick={() => onDuplicateIds(entry.dirName, duplicateIdScan.duplicates)}
                >
                  {plural(duplicateIdScan.duplicates.length, 'duplicate ID')}
                </Badge>
              </Tooltip>
            )}
            {duplicateIdScan !== undefined &&
              duplicateIdScan?.state !== 'found' &&
              duplicateIdScan?.state !== 'none' && (
                <Tooltip label={duplicateUncheckedReason(duplicateIdScan)} multiline maw={320}>
                  <Badge
                    color="gray"
                    variant="outline"
                    data-testid={`duplicate-ids-unchecked-${entry.dirName}`}
                  >
                    IDs not checked
                  </Badge>
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
