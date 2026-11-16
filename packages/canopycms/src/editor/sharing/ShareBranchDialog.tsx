'use client'

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ActionIcon,
  Alert,
  Avatar,
  Button,
  Group,
  Modal,
  Radio,
  Skeleton,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  VisuallyHidden,
} from '@mantine/core'
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconInfoCircle,
  IconLink,
  IconUsers,
  IconX,
} from '@tabler/icons-react'

import type { UserSearchResult } from '../../auth/types'
import type { ApiErrorCode } from '../../api/types'
import type { BranchAddBy } from '../../types'
import { isAdmin } from '../../authorization/helpers'
import type { BranchSummary, UserContext } from '../BranchManager'
import { displayBranchName } from '../branch-names'
import { accessRefusalMessage, EDITOR_ACTIONS } from '../copy'
import { useApiClient } from '../context/ApiClientContext'
import { editorBranchLink } from '../editor-utils'
import { isGatewayFailure, isUnanswered, UnansweredError } from '../unanswered'
import { focusReturnProps } from '../utils/focus-return'
import { PeoplePicker } from './PeoplePicker'
import {
  accessChangeBody,
  changeLanded,
  editorsLosingAccess,
  entryKey,
  joinNames,
  narrows,
  NOTHING_STAGED,
  type AccessEntry,
  type Addition,
  type ExcludedEntry,
  type StagedAccess,
} from './share-staging'
import {
  addByLabel,
  LISTED_ONLY_LINE,
  LOCKDOWN_LINE,
  MEMBER_RIGHTS_LINE,
  OPEN_TO_EVERYONE_LINE,
  WIDENING_LINE,
} from './share-copy'
import { isLockout, useBranchAccess } from './useBranchAccess'

export type ShareTarget = Pick<
  BranchSummary,
  'name' | 'shortName' | 'createdBy' | 'editors' | 'sharing' | 'access'
>

export interface ShareBranchDialogProps {
  opened: boolean
  onClose: () => void
  /** Who has access changed, or may have: read the branch list again. */
  onChanged: () => void
  branch: ShareTarget
  /** The branch's `?branch=` value, for "Copy link". */
  urlName: string
  user: UserContext
  getUserMetadata: (userId: string) => Promise<UserSearchResult | null>
  returnFocusTo?: () => HTMLElement | null
}

const UPDATE_FAILED = "Access couldn't be updated. Check your connection and try again."
const UPDATE_UNANSWERED =
  'Updating access may have gone through even though the server didn\'t answer. The list shows what the server has now; choose "Update access" to make sure.'
const NOTHING_TO_UPDATE = 'Nothing has changed yet. Add or remove someone, or change a setting.'

/**
 * Who may open a branch, for someone who may add people to it: a list whose adds, removals and
 * settings are staged, then sent as one change by "Update access". A viewer the server says can't
 * add sees the list read-only.
 */
export function ShareBranchDialog({
  opened,
  onClose,
  returnFocusTo,
  ...body
}: ShareBranchDialogProps) {
  const [busy, setBusy] = useState({ dirty: false, saving: false })
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`Share ${displayBranchName(body.branch)}`}
      size={540}
      closeOnEscape={!busy.saving}
      closeOnClickOutside={!busy.saving && !busy.dirty}
      closeButtonProps={{ disabled: busy.saving }}
      {...focusReturnProps(returnFocusTo)}
    >
      <ShareBranchBody {...body} onClose={onClose} onBusy={setBusy} />
    </Modal>
  )
}

interface Row {
  key: string
  kind: AccessEntry['kind']
  name: string
  avatarUrl?: string
  shownEmail?: string
  addedBy?: string
  isOwner: boolean
  isYou: boolean
  unsaved: boolean
  removable: boolean
  entry?: AccessEntry
  addition?: Addition
}

type LastAction =
  | { kind: 'removed'; key: string; name: string; entry: { kind: Row['kind']; id: string } }
  | { kind: 'unstaged'; key: string; name: string; addition: Addition }
  | { kind: 'allowed'; key: string; name: string }

function ShareBranchBody({
  branch,
  urlName,
  user,
  getUserMetadata,
  onClose,
  onChanged,
  onBusy,
}: Omit<ShareBranchDialogProps, 'opened' | 'returnFocusTo'> & {
  onBusy: (busy: { dirty: boolean; saving: boolean }) => void
}) {
  const client = useApiClient()
  const { state, reload } = useBranchAccess(branch.name)
  const data = state.data
  const [staged, setStaged] = useState<StagedAccess>(NOTHING_STAGED)
  const [lastAction, setLastAction] = useState<LastAction>()
  const [saving, setSaving] = useState(false)
  const [saveProblem, setSaveProblem] = useState<{ tone: 'error' | 'warning'; message: string }>()
  const [refused, setRefused] = useState<ApiErrorCode>()
  const [announcement, setAnnouncement] = useState('')
  const [removedOpen, setRemovedOpen] = useState(false)
  const [names, setNames] = useState<Record<string, UserSearchResult | null>>({})
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const removedRef = useRef<HTMLDivElement>(null)
  const [pendingFocus, setPendingFocus] = useState<
    { remove: number } | { restore: string } | { allow: number }
  >()
  const [linkCopied, setLinkCopied] = useState(false)

  const userIsAdmin = isAdmin(user.groups)
  const owner = branch.createdBy
  const rights = data?.rights ?? branch.sharing
  const canEdit = state.status !== 'refused' && !refused && !!rights?.canAdd
  const canManage = canEdit && !!rights?.canManage
  const body = data ? accessChangeBody(staged, data) : {}
  const dirty = Object.keys(body).length > 0

  useEffect(() => onBusy({ dirty, saving }), [dirty, saving, onBusy])

  const narrowing = !!data && narrows(staged, data)
  const losing = useMemo(
    () =>
      data && narrowing
        ? editorsLosingAccess(branch.editors ?? [], owner, staged, data)
        : ([] as string[]),
    [data, narrowing, branch.editors, owner, staged],
  )
  const showOwnerRow =
    !!data &&
    !data.restricted &&
    !!owner &&
    (!data.openToEveryone || narrowing) &&
    !data.entries.some((entry) => entry.kind === 'user' && entry.id === owner)
  const toName = [...losing, ...(showOwnerRow && owner ? [owner] : [])]
    .filter((id) => !(id in names))
    .join('\n')
  useEffect(() => {
    if (!toName) return
    let current = true
    const ids = toName.split('\n')
    void Promise.all(ids.map((id) => getUserMetadata(id).catch(() => null))).then((found) => {
      if (current)
        setNames((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id, i) => [id, found[i]])) }))
    })
    return () => {
      current = false
    }
  }, [toName, getUserMetadata])
  const nameOf = (id: string) => names[id]?.name || 'Name unavailable'

  const removedKeys = new Set(staged.remove.map(entryKey))
  const rows: Row[] = []
  if (showOwnerRow && owner) {
    rows.push({
      key: entryKey({ kind: 'user', id: owner }),
      kind: 'user',
      name: nameOf(owner),
      avatarUrl: names[owner]?.avatarUrl,
      isOwner: true,
      isYou: owner === user.userId,
      unsaved: false,
      removable: false,
    })
  }
  for (const entry of data?.entries ?? []) {
    const key = entryKey(entry)
    if (removedKeys.has(key)) continue
    const isOwner = entry.kind === 'user' && entry.id === owner
    rows.push({
      key,
      kind: entry.kind,
      name: entry.name,
      avatarUrl: entry.avatarUrl,
      shownEmail: entry.email ?? entry.maskedEmail,
      addedBy: entry.addedBy
        ? entry.addedBy.id === user.userId
          ? 'you'
          : entry.addedBy.name
        : undefined,
      isOwner,
      isYou: entry.kind === 'user' && entry.id === user.userId,
      unsaved: false,
      removable:
        canEdit && (canManage ? userIsAdmin || !isOwner : entry.addedBy?.id === user.userId),
      entry,
    })
  }
  for (const addition of staged.add) {
    rows.push({
      key: entryKey(addition),
      kind: addition.kind,
      name: addition.name,
      avatarUrl: addition.kind === 'user' ? addition.avatarUrl : undefined,
      shownEmail: addition.kind === 'user' ? addition.shownEmail : undefined,
      addedBy: 'you',
      isOwner: false,
      isYou: false,
      unsaved: true,
      removable: true,
      addition,
    })
  }
  const listedKeys = new Set(rows.map((row) => row.key))
  const unexcludedKeys = new Set(staged.unexclude.map(entryKey))
  const excluded = (data?.excluded ?? []).filter((entry) => !unexcludedKeys.has(entryKey(entry)))
  const showRemoved = canManage && excluded.length > 0

  // Focus moves once the list has re-rendered without, or with, the row it acted on.
  useLayoutEffect(() => {
    if (!pendingFocus) return
    setPendingFocus(undefined)
    if ('remove' in pendingFocus) {
      const buttons = listRef.current?.querySelectorAll<HTMLElement>('button[data-share-remove]')
      ;(buttons?.[pendingFocus.remove] ?? inputRef.current)?.focus()
    } else if ('allow' in pendingFocus) {
      const buttons = removedRef.current?.querySelectorAll<HTMLElement>('button[data-share-allow]')
      ;(
        buttons?.[pendingFocus.allow] ?? removedRef.current?.querySelector<HTMLElement>('button')
      )?.focus()
    } else {
      const { restore } = pendingFocus
      Array.from(document.querySelectorAll<HTMLElement>('[data-share-row]'))
        .find((row) => row.getAttribute('data-share-row') === restore)
        ?.querySelector<HTMLElement>('button')
        ?.focus()
    }
  }, [pendingFocus])

  const announce = (message: string) => setAnnouncement(message)

  const add = (addition: Addition) =>
    setStaged((prev) => ({
      ...prev,
      add: listedKeys.has(entryKey(addition)) ? prev.add : [...prev.add, addition],
      restricted: prev.restricted === false ? undefined : prev.restricted,
    }))

  const remove = (row: Row) => {
    const index = rows.filter((r) => r.removable).findIndex((r) => r.key === row.key)
    if (row.addition) {
      const addition = row.addition
      setStaged((prev) => ({ ...prev, add: prev.add.filter((a) => entryKey(a) !== row.key) }))
      setLastAction({ kind: 'unstaged', key: row.key, name: row.name, addition })
    } else if (row.entry) {
      const target = { kind: row.entry.kind, id: row.entry.id }
      setStaged((prev) => ({ ...prev, remove: [...prev.remove, target] }))
      setLastAction({ kind: 'removed', key: row.key, name: row.name, entry: target })
    }
    announce(`Removed ${row.name}`)
    setPendingFocus({ remove: index })
  }

  const allowAgain = (entry: ExcludedEntry, index: number) => {
    setStaged((prev) => ({
      ...prev,
      unexclude: [...prev.unexclude, { kind: entry.kind, id: entry.id }],
    }))
    const key = entryKey(entry)
    setLastAction({ kind: 'allowed', key, name: entry.name })
    announce(`${entry.name} will be allowed again`)
    setPendingFocus({ allow: index })
  }

  const undo = () => {
    if (!lastAction) return
    const { key } = lastAction
    if (lastAction.kind === 'removed') {
      setStaged((prev) => ({ ...prev, remove: prev.remove.filter((r) => entryKey(r) !== key) }))
    } else if (lastAction.kind === 'unstaged') {
      const { addition } = lastAction
      setStaged((prev) => ({ ...prev, add: [...prev.add, addition] }))
    } else {
      setStaged((prev) => ({
        ...prev,
        unexclude: prev.unexclude.filter((r) => entryKey(r) !== key),
      }))
      setRemovedOpen(true)
    }
    announce(
      lastAction.kind === 'allowed'
        ? `${lastAction.name} stays removed`
        : `Restored ${lastAction.name}`,
    )
    setLastAction(undefined)
    setPendingFocus({ restore: key })
  }

  const setGeneralAccess = (value: string) => {
    if (!data) return
    setLastAction(undefined)
    if (value === 'open') {
      setStaged(
        data.restricted
          ? { ...NOTHING_STAGED, restricted: false }
          : (prev) => ({ ...prev, add: [], restricted: undefined }),
      )
    } else {
      setStaged((prev) => ({ ...prev, restricted: data.restricted ? undefined : true }))
    }
  }

  const addThemToo = () => {
    for (const id of losing)
      add({ kind: 'user', id, name: nameOf(id), avatarUrl: names[id]?.avatarUrl })
    announce(`Added ${joinNames(losing.map(nameOf))}`)
  }

  const update = async () => {
    if (!data || !dirty || saving) return
    setSaving(true)
    setSaveProblem(undefined)
    try {
      const result = await client.branches.updateAccess({ branch: branch.name }, body)
      if (isGatewayFailure(result)) throw new UnansweredError()
      if (result.ok) {
        onChanged()
        onClose()
      } else if (isLockout(result.code)) {
        setRefused(result.code)
      } else {
        setSaveProblem({
          tone: 'error',
          message: accessRefusalMessage(result.code) ?? (result.error || UPDATE_FAILED),
        })
      }
    } catch (err: unknown) {
      if (!isUnanswered(err)) {
        console.error(err)
        setSaveProblem({ tone: 'error', message: UPDATE_FAILED })
      } else {
        const fresh = await reload()
        if (fresh && changeLanded(body, fresh)) {
          onChanged()
          onClose()
        } else {
          setSaveProblem({ tone: 'warning', message: UPDATE_UNANSWERED })
        }
      }
    } finally {
      setSaving(false)
    }
  }

  const refusalCode = refused ?? (state.status === 'refused' ? state.code : undefined)
  if (refusalCode) {
    return (
      <Stack gap="md">
        <Alert
          color="yellow"
          variant="light"
          icon={<IconAlertTriangle size={18} aria-hidden />}
          data-testid="share-refused"
        >
          {accessRefusalMessage(refusalCode)}
        </Alert>
        <Group justify="flex-end">
          <Button
            variant="default"
            onClick={() => {
              onChanged()
              onClose()
            }}
          >
            Close
          </Button>
        </Group>
      </Stack>
    )
  }

  const generalValue =
    staged.restricted === false
      ? 'open'
      : staged.restricted || staged.add.length > 0 || data?.restricted || !data?.openToEveryone
        ? 'listed'
        : 'open'
  const addBy: BranchAddBy | undefined = staged.addBy ?? data?.addBy
  const viewerIsOwner = !!rights?.isOwner
  const groupWarnings = userIsAdmin
    ? []
    : staged.remove.filter((r) => r.kind === 'group' && !(user.groups ?? []).includes(r.id))
  const groupName = (id: string) =>
    data?.entries.find((entry) => entry.kind === 'group' && entry.id === id)?.name ?? id

  return (
    <Stack gap="md" data-testid="share-dialog">
      <VisuallyHidden role="status" data-testid="share-status">
        {announcement}
      </VisuallyHidden>
      {canEdit && (
        <PeoplePicker
          branch={branch.name}
          searchable={data?.searchable ?? 'cms-users'}
          addableByEmail={data?.addableByEmail ?? 'all-users'}
          staged={listedKeys}
          onAdd={add}
          onRefused={setRefused}
          announce={announce}
          inputRef={inputRef}
        />
      )}
      <Stack gap="xs">
        <Text size="sm" fw={600} id="share-people-heading">
          People with access
        </Text>
        {state.status === 'failed' && !data && (
          <Alert
            color="red"
            variant="light"
            title="Who has access couldn't be loaded."
            data-testid="share-load-failed"
          >
            <Button variant="default" size="xs" onClick={() => void reload()}>
              Retry
            </Button>
          </Alert>
        )}
        {!data && state.status === 'loading' ? (
          <Stack gap="sm" aria-busy data-testid="share-loading">
            {[0, 1, 2].map((row) => (
              <Group key={row} gap="sm" wrap="nowrap">
                <Skeleton circle height={32} />
                <Stack gap={4} style={{ flex: 1 }}>
                  <Skeleton height={10} width="45%" />
                  <Skeleton height={8} width="30%" />
                </Stack>
              </Group>
            ))}
          </Stack>
        ) : data && rows.length === 0 ? (
          <Text size="sm" c="dimmed">
            No one is listed yet.
          </Text>
        ) : (
          <Stack
            component="ul"
            gap="xs"
            m={0}
            p={0}
            ref={listRef}
            aria-labelledby="share-people-heading"
            style={{ listStyle: 'none' }}
          >
            {rows.map((row) => (
              <AccessRow key={row.key} row={row} onRemove={() => remove(row)} />
            ))}
          </Stack>
        )}
        {(lastAction || groupWarnings.length > 0 || staged.restricted === false) && (
          <Stack gap={4} data-testid="share-status-line">
            {lastAction && (
              <Group gap="xs">
                <Text size="sm">
                  {lastAction.kind === 'allowed'
                    ? `${lastAction.name} will be allowed again.`
                    : `Removed ${lastAction.name}.`}
                </Text>
                <Button variant="subtle" size="compact-sm" onClick={undo}>
                  Undo
                </Button>
              </Group>
            )}
            {groupWarnings.map((group) => (
              <Group key={group.id} gap={6} wrap="nowrap">
                <IconAlertTriangle
                  size={16}
                  color="var(--mantine-color-yellow-filled)"
                  aria-hidden
                />
                <Text size="sm">{`You can't add ${groupName(group.id)} back yourself.`}</Text>
              </Group>
            ))}
            {staged.restricted === false && (
              <Group gap={6} wrap="nowrap">
                <IconAlertTriangle
                  size={16}
                  color="var(--mantine-color-yellow-filled)"
                  aria-hidden
                />
                <Text size="sm">{WIDENING_LINE}</Text>
              </Group>
            )}
          </Stack>
        )}
        {narrowing && losing.length > 0 && (
          <Alert
            color="yellow"
            variant="light"
            icon={<IconAlertTriangle size={18} aria-hidden />}
            data-testid="share-narrowing"
          >
            <Group gap="xs">
              <Text size="sm">
                {`${joinNames(losing.map(nameOf))} ${losing.length === 1 ? 'is' : 'are'} working on this branch and will lose access.`}
              </Text>
              <Button variant="default" size="compact-sm" onClick={addThemToo}>
                Add them too
              </Button>
            </Group>
          </Alert>
        )}
        {showRemoved && (
          <div ref={removedRef}>
            <UnstyledButton
              onClick={() => setRemovedOpen(!removedOpen)}
              aria-expanded={removedOpen}
              data-testid="share-removed-toggle"
            >
              <Group gap={4} wrap="nowrap">
                {removedOpen ? (
                  <IconChevronDown size={16} aria-hidden />
                ) : (
                  <IconChevronRight size={16} aria-hidden />
                )}
                <Text size="sm" fw={600}>
                  Removed ({excluded.length})
                </Text>
              </Group>
            </UnstyledButton>
            {removedOpen && (
              <Stack component="ul" gap="xs" m={0} mt="xs" p={0} style={{ listStyle: 'none' }}>
                {excluded.map((entry, index) => (
                  <Group
                    component="li"
                    key={entryKey(entry)}
                    justify="space-between"
                    wrap="nowrap"
                    data-share-row={entryKey(entry)}
                  >
                    <PersonLabel
                      kind={entry.kind}
                      name={entry.name}
                      detail={
                        entry.byAdmin && !userIsAdmin
                          ? 'Removed by an admin'
                          : `Removed by ${entry.by.id === user.userId ? 'you' : entry.by.name}`
                      }
                    />
                    {(userIsAdmin || !entry.byAdmin) && (
                      <Button
                        variant="default"
                        size="compact-sm"
                        onClick={() => allowAgain(entry, index)}
                        aria-label={`Allow again: ${entry.name}`}
                        data-share-allow
                      >
                        Allow again
                      </Button>
                    )}
                  </Group>
                ))}
              </Stack>
            )}
          </div>
        )}
      </Stack>
      {data && (
        <Stack gap="sm">
          {userIsAdmin && branch.access?.managerOrAdminAllowed && (
            <Text size="sm" data-testid="share-lockdown">
              {LOCKDOWN_LINE}
            </Text>
          )}
          {canManage && addBy ? (
            <Radio.Group
              label="Who can add people"
              value={addBy}
              onChange={(value) =>
                setStaged((prev) => ({
                  ...prev,
                  addBy: value === data.addBy ? undefined : (value as BranchAddBy),
                }))
              }
            >
              <Group gap="md" mt={4}>
                <Radio value="members" label={addByLabel('members', viewerIsOwner)} />
                <Radio value="owner" label={addByLabel('owner', viewerIsOwner)} />
                {userIsAdmin && (
                  <Radio value="admins" label={addByLabel('admins', viewerIsOwner)} />
                )}
              </Group>
            </Radio.Group>
          ) : (
            addBy && <Text size="sm">Who can add people: {addByLabel(addBy, viewerIsOwner)}</Text>
          )}
          {data.defaultAccess !== 'allow' ? (
            <Text size="sm" data-testid="share-general-access">
              {LISTED_ONLY_LINE}
            </Text>
          ) : canManage ? (
            <Radio.Group label="General access" value={generalValue} onChange={setGeneralAccess}>
              <Stack gap={6} mt={4}>
                <Radio value="open" label="Anyone who can sign in to the editor" />
                <Radio value="listed" label="Only people listed here" />
              </Stack>
            </Radio.Group>
          ) : (
            <Text size="sm" data-testid="share-general-access">
              {data.openToEveryone ? OPEN_TO_EVERYONE_LINE : LISTED_ONLY_LINE}
            </Text>
          )}
          <Group gap={6} wrap="nowrap" align="flex-start">
            <IconInfoCircle
              size={16}
              color="var(--mantine-color-blue-filled)"
              aria-hidden
              style={{ flexShrink: 0, marginTop: 2 }}
            />
            <Text size="sm">{MEMBER_RIGHTS_LINE}</Text>
          </Group>
        </Stack>
      )}
      {saveProblem && (
        <Alert
          color={saveProblem.tone === 'error' ? 'red' : 'yellow'}
          variant="light"
          icon={<IconAlertTriangle size={18} aria-hidden />}
          data-testid="share-save-problem"
        >
          <Stack gap="xs" align="flex-start">
            <Text size="sm">{saveProblem.message}</Text>
            <Button variant="default" size="xs" onClick={() => void update()}>
              Retry
            </Button>
          </Stack>
        </Alert>
      )}
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Button
          variant="subtle"
          leftSection={
            linkCopied ? <IconCheck size={16} aria-hidden /> : <IconLink size={16} aria-hidden />
          }
          onClick={() => {
            const link = editorBranchLink(window.location.href, urlName)
            Promise.resolve()
              .then(() => navigator.clipboard.writeText(link))
              .then(() => {
                setLinkCopied(true)
                announce('Link copied')
              })
              .catch(() => announce("Couldn't copy the link"))
          }}
        >
          {EDITOR_ACTIONS.copyLink}
        </Button>
        <Group gap="sm">
          <Button variant="default" onClick={onClose} disabled={saving}>
            {!canEdit ? 'Close' : dirty ? 'Discard changes' : 'Cancel'}
          </Button>
          {canEdit && (
            <Tooltip label={NOTHING_TO_UPDATE} disabled={dirty || !data} multiline maw={260}>
              <Button
                onClick={() => {
                  if (dirty) void update()
                }}
                loading={saving}
                data-disabled={!dirty || undefined}
                aria-disabled={!dirty || undefined}
                data-testid="share-update"
              >
                {EDITOR_ACTIONS.updateAccess}
              </Button>
            </Tooltip>
          )}
        </Group>
      </Group>
    </Stack>
  )
}

export function PersonLabel({
  kind,
  name,
  avatarUrl,
  detail,
  suffix,
}: {
  kind: Row['kind']
  name: string
  avatarUrl?: string
  detail?: string
  suffix?: string
}) {
  return (
    <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
      <Avatar
        src={kind === 'user' ? avatarUrl : undefined}
        alt=""
        size={32}
        radius="xl"
        aria-hidden
      >
        {kind === 'group' ? <IconUsers size={16} /> : name.charAt(0)}
      </Avatar>
      <Stack gap={0} style={{ minWidth: 0 }}>
        <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
          {name}
          {suffix}
        </Text>
        {detail && (
          <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
            {detail}
          </Text>
        )}
      </Stack>
    </Group>
  )
}

function AccessRow({ row, onRemove }: { row: Row; onRemove: () => void }) {
  const details = [
    row.kind === 'group' ? 'Group' : row.shownEmail,
    row.addedBy && `Added by ${row.addedBy}`,
    row.unsaved && 'Unsaved',
  ].filter(Boolean)
  const removeLabel = `Remove ${row.name}`
  return (
    <Group component="li" justify="space-between" wrap="nowrap" data-share-row={row.key}>
      <PersonLabel
        kind={row.kind}
        name={row.name}
        avatarUrl={row.avatarUrl}
        suffix={row.isYou ? ' (you)' : undefined}
        detail={details.join(' · ') || undefined}
      />
      <Group gap="xs" wrap="nowrap">
        {row.isOwner && (
          <Text size="sm" c="dimmed">
            Owner
          </Text>
        )}
        {row.removable && (
          <Tooltip label={removeLabel}>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label={removeLabel}
              onClick={onRemove}
              data-share-remove
            >
              <IconX size={16} aria-hidden />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    </Group>
  )
}
