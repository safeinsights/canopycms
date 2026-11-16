'use client'

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ActionIcon,
  Alert,
  Avatar,
  Button,
  Fieldset,
  Group,
  Modal,
  Radio,
  Skeleton,
  Stack,
  Text,
  TextInput,
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
import { personInitials } from '../../auth/person-name'
import { isAdmin } from '../../authorization/helpers'
import type { BranchSummary, UserContext } from '../BranchManager'
import { displayBranchName } from '../branch-names'
import { accessRefusalMessage, EDITOR_ACTIONS } from '../copy'
import { useApiClient } from '../context/ApiClientContext'
import { editorBranchLink } from '../editor-utils'
import { isGatewayFailure, isUnanswered, UnansweredError } from '../unanswered'
import { focusReturnProps } from '../utils/focus-return'
import { accessPeople } from './BranchShareControl'
import { PeoplePicker } from './PeoplePicker'
import {
  accessChangeBody,
  changeLanded,
  editorsLosingAccess,
  entryKey,
  isPersonId,
  joinNames,
  narrows,
  NOTHING_STAGED,
  withAddition,
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
  'Updating access may have gone through even though the server didn\'t answer. The list shows what the server has now; choose "Update access" to send your changes again.'
const NOTHING_TO_UPDATE = 'Nothing has changed yet. Add or remove someone, or change a setting.'
const NOT_LOADED = "Who has access hasn't loaded yet. Retry above."
const STILL_LOADING = 'Who has access is still loading.'
const COPIED_FOR_MS = 3000
const MAX_LOADING_ROWS = 8

interface BodyState {
  dirty: boolean
  saving: boolean
  refused: boolean
}

/**
 * Who may open a branch, for someone who may add people to it: a list whose adds, removals and
 * settings are staged, then sent as one change by "Update access". A viewer the server says can't
 * add sees the list read-only. Esc and ✕ follow the dismiss button: while an update is on its way
 * they do nothing; with edits staged they ask before discarding them; once a refusal has replaced
 * the dialog, they close it and read the branch list again, as its Close does.
 */
export function ShareBranchDialog({
  opened,
  onClose,
  onChanged,
  returnFocusTo,
  ...body
}: ShareBranchDialogProps) {
  const [state, setState] = useState<BodyState>({ dirty: false, saving: false, refused: false })
  const [discardAsked, setDiscardAsked] = useState(0)
  // Once nothing is staged, a later Esc asks afresh rather than reopening an old question.
  const report = useCallback((next: BodyState) => {
    setState(next)
    if (!next.dirty) setDiscardAsked(0)
  }, [])
  const close = () => {
    setDiscardAsked(0)
    if (state.refused) onChanged()
    onClose()
  }
  const dismiss = () => {
    if (state.saving) return
    if (state.dirty) setDiscardAsked((n) => n + 1)
    else close()
  }
  return (
    <Modal
      opened={opened}
      onClose={dismiss}
      title={`Share “${displayBranchName(body.branch)}”`}
      size={540}
      closeOnClickOutside={!state.saving && !state.dirty}
      closeButtonProps={{ disabled: state.saving }}
      {...focusReturnProps(returnFocusTo)}
    >
      <ShareBranchBody
        {...body}
        onClose={close}
        onChanged={onChanged}
        onState={report}
        discardAsked={discardAsked}
        onKeepEditing={() => setDiscardAsked(0)}
      />
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
  /** Staged for removal: shown struck through, with its own Undo. */
  removing: boolean
  removable: boolean
  entry?: AccessEntry
  addition?: Addition
}

type LastAction =
  | { kind: 'unstaged'; key: string; name: string; addition: Addition }
  | { kind: 'allowed'; key: string; name: string; via: 'add' | 'unexclude'; message: string }

interface SaveProblem {
  tone: 'error' | 'warning'
  message: string
  /**
   * A request that threw other than by timing out, an answer with no code (a non-API one included,
   * below 500), a rate limit, or a list changed meanwhile. A timeout or a gateway's 5xx takes the
   * unanswered path instead.
   */
  retryable: boolean
  ids?: string[]
}

function ShareBranchBody({
  branch,
  urlName,
  user,
  getUserMetadata,
  onClose,
  onChanged,
  onState,
  discardAsked,
  onKeepEditing,
}: Omit<ShareBranchDialogProps, 'opened' | 'returnFocusTo'> & {
  onState: (state: BodyState) => void
  discardAsked: number
  onKeepEditing: () => void
}) {
  const client = useApiClient()
  const { state, reload } = useBranchAccess(branch.name)
  const data = state.data
  const [staged, setStaged] = useState<StagedAccess>(NOTHING_STAGED)
  const stagedRef = useRef(staged)
  stagedRef.current = staged
  const [lastAction, setLastAction] = useState<LastAction>()
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [saveProblem, setSaveProblem] = useState<SaveProblem>()
  const [refused, setRefused] = useState<ApiErrorCode>()
  const [announcement, setAnnouncement] = useState('')
  const [removedOpen, setRemovedOpen] = useState(false)
  const [names, setNames] = useState<Record<string, UserSearchResult | null>>({})
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const inputRef = useRef<HTMLInputElement>(null)
  const headingRef = useRef<HTMLParagraphElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const keepEditingRef = useRef<HTMLButtonElement>(null)
  const undoRef = useRef<HTMLButtonElement>(null)
  const copyFieldRef = useRef<HTMLInputElement>(null)
  const beforeAskRef = useRef<HTMLElement | null>(null)
  const [pendingFocus, setPendingFocus] = useState<
    { remove: number } | { restore: string } | { undo: true }
  >()

  const userIsAdmin = isAdmin(user.groups)
  const owner = branch.createdBy
  const rights = data?.rights ?? branch.sharing
  const refusalCode = refused ?? (state.status === 'refused' ? state.code : undefined)
  const canEdit = !refusalCode && !!rights?.canAdd
  const canManage = canEdit && !!rights?.canManage
  const body = data ? accessChangeBody(staged, data) : {}
  const dirty = Object.keys(body).length > 0
  const lockedDown = !!branch.access?.managerOrAdminAllowed
  // As many placeholder rows as the listing says the list holds (1 to 8), so the footer barely moves
  // as the list loads.
  const known = accessPeople(branch)
  const loadingRows = Math.min(
    Math.max(known.users.length + known.groups.length, 1),
    MAX_LOADING_ROWS,
  )

  // A refusal replaces the edits with its notice, so nothing is left to ask about discarding.
  useEffect(
    () => onState({ dirty: dirty && !refusalCode, saving, refused: !!refusalCode }),
    [dirty, saving, refusalCode, onState],
  )

  const firstLoad = useRef(true)
  useEffect(() => {
    if (!data || !firstLoad.current) return
    firstLoad.current = false
    const active = document.activeElement
    const dialog = rootRef.current?.closest('[role="dialog"]')
    if (
      canEdit &&
      (!active ||
        !dialog?.contains(active) ||
        active === dialog ||
        active === headingRef.current ||
        !!active.closest('.mantine-Modal-close'))
    ) {
      inputRef.current?.focus()
    }
  }, [data, canEdit])

  useEffect(() => {
    if (copy !== 'copied') return
    const timer = setTimeout(() => setCopy('idle'), COPIED_FOR_MS)
    return () => clearTimeout(timer)
  }, [copy])

  const showDiscard = discardAsked > 0 && dirty
  useEffect(() => {
    if (discardAsked === 0) return
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== keepEditingRef.current) {
      beforeAskRef.current = active
    }
    keepEditingRef.current?.focus()
  }, [discardAsked])

  const excludedIds = new Set((data?.excluded ?? []).map((entry) => entry.id))
  const generalValue =
    staged.restricted === false
      ? 'open'
      : staged.restricted ||
          staged.add.length > 0 ||
          data?.restricted ||
          (data && data.defaultAccess !== 'allow')
        ? 'listed'
        : 'open'
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
    isPersonId(owner) &&
    !excludedIds.has(owner) &&
    (data.defaultAccess !== 'allow' || narrowing) &&
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
      removing: false,
      removable: false,
    })
  }
  for (const entry of data?.entries ?? []) {
    const key = entryKey(entry)
    const isOwner = entry.kind === 'user' && entry.id === owner
    rows.push({
      key,
      kind: entry.kind,
      name: entry.name,
      avatarUrl: entry.avatarUrl,
      shownEmail: entry.email ?? entry.maskedEmail,
      // The owner's row says Owner, not who put them on the list: the first share does that
      // (authorization/branch-sharing.ts `applyAccessChange`).
      addedBy:
        entry.addedBy && !isOwner
          ? entry.addedBy.id === user.userId
            ? 'you'
            : entry.addedBy.name
          : undefined,
      isOwner,
      isYou: entry.kind === 'user' && entry.id === user.userId,
      unsaved: false,
      removing: removedKeys.has(key),
      removable:
        canEdit && (canManage ? userIsAdmin || !isOwner : entry.addedBy?.id === user.userId),
      entry,
    })
  }
  const entryKeys = new Set(rows.map((row) => row.key))
  for (const addition of staged.add) {
    if (entryKeys.has(entryKey(addition))) continue
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
      removing: false,
      removable: true,
      addition,
    })
  }
  const listedKeys = new Set(rows.map((row) => row.key))
  const allowedKeys = new Set([...staged.unexclude.map(entryKey), ...staged.add.map(entryKey)])
  const excluded = (data?.excluded ?? []).filter((entry) => !allowedKeys.has(entryKey(entry)))
  const showRemoved = canManage && excluded.length > 0

  // Focus moves once the list has re-rendered without, or with, the row it acted on.
  useLayoutEffect(() => {
    if (!pendingFocus) return
    setPendingFocus(undefined)
    const fallback = inputRef.current ?? headingRef.current
    if ('remove' in pendingFocus) {
      const buttons = listRef.current?.querySelectorAll<HTMLElement>('button[data-share-remove]')
      ;(buttons?.[pendingFocus.remove] ?? fallback)?.focus()
    } else if ('undo' in pendingFocus) {
      ;(undoRef.current ?? fallback)?.focus()
    } else {
      const { restore } = pendingFocus
      Array.from(document.querySelectorAll<HTMLElement>('[data-share-row]'))
        .find((row) => row.getAttribute('data-share-row') === restore)
        ?.querySelector<HTMLElement>('button')
        ?.focus()
    }
  }, [pendingFocus])

  const announce = (message: string) => setAnnouncement(message)

  /** Any change to the list keeps it, so a staged "Anyone who can sign in" gives way. */
  const edit = (change: (prev: StagedAccess) => StagedAccess) => {
    setSaveProblem(undefined)
    setStaged((prev) => {
      const next = change(prev)
      return next.restricted === false ? { ...next, restricted: undefined } : next
    })
  }

  const add = (addition: Addition) =>
    edit((prev) => ({ ...prev, add: withAddition(prev.add, addition, listedKeys) }))

  const remove = (row: Row) => {
    const index = rows.filter((r) => r.removable && !r.removing).findIndex((r) => r.key === row.key)
    const { addition, entry } = row
    if (addition) {
      edit((prev) => ({ ...prev, add: prev.add.filter((a) => entryKey(a) !== row.key) }))
      setLastAction({ kind: 'unstaged', key: row.key, name: row.name, addition })
    } else if (entry) {
      edit((prev) =>
        prev.remove.some((r) => entryKey(r) === row.key)
          ? prev
          : { ...prev, remove: [...prev.remove, { kind: entry.kind, id: entry.id }] },
      )
    }
    announce(`Removed ${row.name}`)
    setPendingFocus({ remove: index })
  }

  const keep = (row: Row) => {
    edit((prev) => ({ ...prev, remove: prev.remove.filter((r) => entryKey(r) !== row.key) }))
    announce(`Restored ${row.name}`)
    setPendingFocus({ restore: row.key })
  }

  /** Stages `entry` back: on the list when it is limited to it, focusing that row, else its Undo. */
  const allowAgain = (entry: ExcludedEntry) => {
    const key = entryKey(entry)
    // The edit below takes back a staged "Anyone who can sign in", so the list will stand.
    const listOnly = staged.restricted === false ? !!data?.restricted : generalValue === 'listed'
    const canAddBack =
      entry.kind === 'user' || userIsAdmin || (user.groups ?? []).includes(entry.id)
    if (listOnly && canAddBack) {
      edit((prev) => ({
        ...prev,
        add: withAddition(prev.add, { kind: entry.kind, id: entry.id, name: entry.name }),
      }))
      const message = `${entry.name} will be added back.`
      setLastAction({ kind: 'allowed', key, name: entry.name, via: 'add', message })
      announce(message)
      setPendingFocus({ restore: key })
    } else {
      const message = listOnly
        ? `${entry.name} will be allowed again, but not added back to the list.`
        : `${entry.name} will be able to open this branch again.`
      edit((prev) => ({
        ...prev,
        unexclude: [...prev.unexclude, { kind: entry.kind, id: entry.id }],
      }))
      setLastAction({
        kind: 'allowed',
        key,
        name: entry.name,
        via: 'unexclude',
        message,
      })
      announce(message)
      setPendingFocus({ undo: true })
    }
  }

  const undo = () => {
    if (!lastAction) return
    const { key } = lastAction
    if (lastAction.kind === 'unstaged') {
      const { addition } = lastAction
      edit((prev) => ({ ...prev, add: withAddition(prev.add, addition) }))
      announce(`Restored ${lastAction.name}`)
    } else {
      edit((prev) =>
        lastAction.via === 'add'
          ? { ...prev, add: prev.add.filter((a) => entryKey(a) !== key) }
          : { ...prev, unexclude: prev.unexclude.filter((r) => entryKey(r) !== key) },
      )
      setRemovedOpen(true)
      announce(`${lastAction.name} stays removed`)
    }
    setLastAction(undefined)
    setPendingFocus({ restore: key })
  }

  const setGeneralAccess = (value: string) => {
    if (!data) return
    setLastAction(undefined)
    setSaveProblem(undefined)
    if (value === 'open') {
      setStaged(
        data.restricted
          ? { ...NOTHING_STAGED, restricted: false }
          : (prev) => ({ ...prev, add: [], addBy: undefined, restricted: undefined }),
      )
    } else {
      setStaged((prev) => ({ ...prev, restricted: data.restricted ? undefined : true }))
    }
  }

  const addThemToo = () => {
    edit((prev) => ({
      ...prev,
      add: losing.reduce(
        (list, id) =>
          withAddition(list, {
            kind: 'user',
            id,
            name: nameOf(id),
            avatarUrl: names[id]?.avatarUrl,
          }),
        prev.add,
      ),
    }))
    announce(`Added ${joinNames(losing.map(nameOf))}`)
  }

  const finish = (sent: StagedAccess) => {
    onChanged()
    if (stagedRef.current === sent) onClose()
    else void reload()
  }

  /**
   * Whether a scope refusal names only people staged for removal. The server checks a removal's
   * scope only when someone who manages the list, not an admin, removes a person it no longer
   * holds and hasn't removed already, who doesn't work in this CMS (api/branch-access.ts
   * `unlisted`); so someone took them off first.
   */
  const goneFromList = (code: ApiErrorCode | undefined, ids: string[] | undefined): boolean =>
    code === 'USER_OUT_OF_SCOPE' &&
    !!ids?.length &&
    ids.every((id) => staged.remove.some((r) => r.kind === 'user' && r.id === id))

  const update = async () => {
    if (!data || !dirty || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setSaveProblem(undefined)
    const sent = staged
    try {
      const result = await client.branches.updateAccess({ branch: branch.name }, body)
      if (isGatewayFailure(result)) throw new UnansweredError()
      if (result.ok) {
        finish(sent)
      } else if (isLockout(result.code, result.ids)) {
        setRefused(result.code)
      } else if (goneFromList(result.code, result.ids)) {
        const fresh = await reload()
        const gone = fresh
          ? (result.ids ?? []).filter(
              (id) => !fresh.entries.some((entry) => entry.kind === 'user' && entry.id === id),
            )
          : []
        if (gone.length > 0) {
          const goneNames = gone.map(
            (id) => data.entries.find((entry) => entry.id === id)?.name ?? 'Name unavailable',
          )
          setStaged((prev) => ({
            ...prev,
            remove: prev.remove.filter((r) => !(r.kind === 'user' && gone.includes(r.id))),
          }))
          setSaveProblem({
            tone: 'warning',
            message: `${joinNames(goneNames)} ${gone.length === 1 ? 'is' : 'are'} no longer on the list.`,
            retryable: false,
          })
        } else {
          setSaveProblem({
            tone: 'error',
            message: accessRefusalMessage(result.code) ?? (result.error || UPDATE_FAILED),
            retryable: false,
            ids: result.ids,
          })
        }
      } else {
        setSaveProblem({
          tone: result.code === 'LIST_CHANGED' ? 'warning' : 'error',
          message: accessRefusalMessage(result.code) ?? (result.error || UPDATE_FAILED),
          retryable:
            !result.code || result.code === 'RATE_LIMITED' || result.code === 'LIST_CHANGED',
          ids: result.ids,
        })
      }
    } catch (err: unknown) {
      if (!isUnanswered(err)) {
        console.error(err)
        setSaveProblem({ tone: 'error', message: UPDATE_FAILED, retryable: true })
      } else {
        const fresh = await reload()
        if (fresh && changeLanded(body, fresh)) finish(sent)
        else setSaveProblem({ tone: 'warning', message: UPDATE_UNANSWERED, retryable: false })
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const copyLink = () => {
    const link = editorBranchLink(window.location.href, urlName)
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(link))
      .then(
        () => {
          setCopy('copied')
          announce('Link copied')
        },
        () => {
          setCopy('failed')
          announce("Couldn't copy the link")
          requestAnimationFrame(() => copyFieldRef.current?.focus())
        },
      )
  }

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
          <Button variant="default" onClick={onClose}>
            Close
          </Button>
        </Group>
      </Stack>
    )
  }

  const addBy: BranchAddBy | undefined = staged.addBy ?? data?.addBy
  const viewerIsOwner = !!rights?.isOwner
  const groupWarnings = userIsAdmin
    ? []
    : staged.remove.filter((r) => r.kind === 'group' && !(user.groups ?? []).includes(r.id))
  const groupName = (id: string) =>
    data?.entries.find((entry) => entry.kind === 'group' && entry.id === id)?.name ?? id
  const nameForId = (id: string): string | undefined =>
    staged.add.find((a) => a.id === id)?.name ??
    data?.entries.find((entry) => entry.id === id)?.name ??
    data?.excluded?.find((entry) => entry.id === id)?.name ??
    names[id]?.name ??
    undefined
  const problemNames = (saveProblem?.ids ?? []).flatMap((id) => nameForId(id) ?? [])
  const problemRows = rows.filter(
    (row) => row.addition?.id !== undefined && saveProblem?.ids?.includes(row.addition.id),
  )
  const mayLose =
    data?.entries.some((entry) => entry.kind === 'group') ||
    staged.add.some((addition) => addition.kind === 'group')
  const notReadyReason = !data
    ? state.status === 'failed'
      ? NOT_LOADED
      : STILL_LOADING
    : undefined
  const updateReason = notReadyReason ?? (dirty ? undefined : NOTHING_TO_UPDATE)
  const warningIcon = <IconAlertTriangle size={16} color="var(--mantine-color-text)" aria-hidden />

  return (
    <Stack gap="md" ref={rootRef} data-testid="share-dialog">
      <VisuallyHidden role="status" data-testid="share-status">
        {announcement}
      </VisuallyHidden>
      <Fieldset variant="unstyled" disabled={saving} p={0} m={0} data-testid="share-editing">
        <Stack gap="md">
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
              disabledReason={
                data
                  ? undefined
                  : state.status === 'failed'
                    ? NOT_LOADED
                    : 'Loading who has access…'
              }
            />
          )}
          <Stack gap="xs">
            <Text
              size="sm"
              fw={600}
              id="share-people-heading"
              ref={headingRef}
              tabIndex={-1}
              data-autofocus={!(canEdit && data) || undefined}
            >
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
                {Array.from({ length: loadingRows }, (_, row) => (
                  <Group key={row} gap="sm" wrap="nowrap" data-testid="share-loading-row">
                    <Skeleton circle height={32} />
                    <Stack gap={4} style={{ flex: 1 }}>
                      <Skeleton height={10} width="45%" />
                      <Skeleton height={8} width="30%" />
                    </Stack>
                  </Group>
                ))}
                <Skeleton height={12} width="35%" mt="sm" />
                <Skeleton height={20} width="60%" />
                <Skeleton height={12} width="85%" />
                <Skeleton height={32} width="100%" />
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
                  <AccessRow
                    key={row.key}
                    row={row}
                    onRemove={() => remove(row)}
                    onKeep={() => keep(row)}
                  />
                ))}
              </Stack>
            )}
            {(lastAction ||
              groupWarnings.length > 0 ||
              staged.restricted === false ||
              showDiscard) && (
              <Stack gap={4} data-testid="share-status-line">
                {lastAction && (
                  <Group gap="xs">
                    <Text size="sm">
                      {lastAction.kind === 'allowed'
                        ? lastAction.message
                        : `Removed ${lastAction.name}.`}
                    </Text>
                    <Button variant="subtle" size="compact-sm" onClick={undo} ref={undoRef}>
                      Undo
                    </Button>
                  </Group>
                )}
                {groupWarnings.map((group) => (
                  <Group key={group.id} gap={6} wrap="nowrap">
                    {warningIcon}
                    <Text size="sm">{`You can't add ${groupName(group.id)} back yourself.`}</Text>
                  </Group>
                ))}
                {staged.restricted === false && (
                  <Group gap={6} wrap="nowrap">
                    {warningIcon}
                    <Text size="sm">{WIDENING_LINE}</Text>
                  </Group>
                )}
                {showDiscard && (
                  <Group gap="xs" data-testid="share-discard-confirm">
                    <Text size="sm">Discard your changes?</Text>
                    <Button variant="default" size="compact-sm" onClick={onClose}>
                      Discard changes
                    </Button>
                    <Button
                      variant="subtle"
                      size="compact-sm"
                      ref={keepEditingRef}
                      onClick={() => {
                        onKeepEditing()
                        const back = beforeAskRef.current
                        ;(back?.isConnected
                          ? back
                          : (inputRef.current ?? headingRef.current)
                        )?.focus()
                      }}
                    >
                      Keep editing
                    </Button>
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
                    {`${joinNames(losing.map(nameOf))} ${losing.length === 1 ? 'is' : 'are'} working on this branch and ${mayLose ? 'may' : 'will'} lose access.`}
                  </Text>
                  <Button variant="default" size="compact-sm" onClick={addThemToo}>
                    Add them too
                  </Button>
                </Group>
              </Alert>
            )}
            {showRemoved && (
              <div>
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
                    {excluded.map((entry) => (
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
                            onClick={() => allowAgain(entry)}
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
              {generalValue === 'listed' &&
                (canManage && addBy ? (
                  <Radio.Group
                    label="Who can add people"
                    value={addBy}
                    onChange={(value) =>
                      edit((prev) => ({
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
                  addBy && (
                    <Text size="sm">Who can add people: {addByLabel(addBy, viewerIsOwner)}</Text>
                  )
                ))}
              {lockedDown && (
                <Text size="sm" data-testid="share-lockdown">
                  {LOCKDOWN_LINE}
                </Text>
              )}
              {data.defaultAccess === 'allow' && canManage ? (
                <Radio.Group
                  label="General access"
                  value={generalValue}
                  onChange={setGeneralAccess}
                >
                  <Stack gap={6} mt={4}>
                    <Radio value="open" label="Anyone who can sign in to the editor" />
                    <Radio value="listed" label="Only people listed here" />
                  </Stack>
                </Radio.Group>
              ) : (
                !lockedDown && (
                  <Text size="sm" data-testid="share-general-access">
                    {data.defaultAccess === 'allow' && !data.restricted
                      ? OPEN_TO_EVERYONE_LINE
                      : LISTED_ONLY_LINE}
                  </Text>
                )
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
        </Stack>
      </Fieldset>
      {saveProblem && (
        <Alert
          color={saveProblem.tone === 'error' ? 'red' : 'yellow'}
          variant="light"
          icon={<IconAlertTriangle size={18} aria-hidden />}
          data-testid="share-save-problem"
        >
          <Stack gap="xs" align="flex-start">
            <Text size="sm">{saveProblem.message}</Text>
            {problemNames.length > 0 && (
              <Text size="sm">{`Applies to ${joinNames(problemNames)}.`}</Text>
            )}
            {saveProblem.retryable ? (
              <Button variant="default" size="xs" onClick={() => void update()}>
                Retry
              </Button>
            ) : (
              saveProblem.tone === 'error' &&
              problemRows.length > 0 && (
                <Group gap="xs">
                  {problemRows.map((row) => (
                    <Button key={row.key} variant="default" size="xs" onClick={() => remove(row)}>
                      {`Remove ${row.name}`}
                    </Button>
                  ))}
                </Group>
              )
            )}
          </Stack>
        </Alert>
      )}
      {copy === 'failed' && (
        <Stack gap={4} data-testid="share-copy-failed">
          <Text size="sm" c="var(--canopy-danger-text)">
            {"Couldn't copy the link. Select it here and copy it yourself."}
          </Text>
          <TextInput
            ref={copyFieldRef}
            readOnly
            aria-label="Link to this branch"
            value={editorBranchLink(window.location.href, urlName)}
            onFocus={(event) => event.currentTarget.select()}
          />
        </Stack>
      )}
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Button
          variant="subtle"
          leftSection={
            copy === 'copied' ? (
              <IconCheck size={16} aria-hidden />
            ) : (
              <IconLink size={16} aria-hidden />
            )
          }
          onClick={copyLink}
        >
          {EDITOR_ACTIONS.copyLink}
        </Button>
        <Group gap="sm">
          {/* While the status line asks, its own Discard changes is the one way to discard. */}
          {!showDiscard && (
            <Button variant="default" onClick={onClose} disabled={saving}>
              {!canEdit ? 'Close' : dirty ? 'Discard changes' : 'Cancel'}
            </Button>
          )}
          {canEdit && (
            <Tooltip label={updateReason} disabled={!updateReason} multiline maw={260}>
              <Button
                onClick={() => {
                  if (!updateReason) void update()
                }}
                loading={saving}
                data-disabled={!!updateReason || undefined}
                aria-disabled={!!updateReason || undefined}
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
  struck = false,
}: {
  kind: Row['kind']
  name: string
  avatarUrl?: string
  detail?: string
  suffix?: string
  struck?: boolean
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
        {kind === 'group' ? <IconUsers size={16} /> : personInitials(name)}
      </Avatar>
      <Stack gap={0} style={{ minWidth: 0 }}>
        <Text
          size="sm"
          td={struck ? 'line-through' : undefined}
          style={{ overflowWrap: 'anywhere' }}
        >
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

function AccessRow({
  row,
  onRemove,
  onKeep,
}: {
  row: Row
  onRemove: () => void
  onKeep: () => void
}) {
  const details = row.removing
    ? ['Will be removed']
    : [
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
        struck={row.removing}
      />
      <Group gap="xs" wrap="nowrap">
        {row.isOwner && (
          <Text size="sm" c="dimmed">
            Owner
          </Text>
        )}
        {row.removing ? (
          <Button
            variant="subtle"
            size="compact-sm"
            onClick={onKeep}
            aria-label={`Undo removing ${row.name}`}
          >
            Undo
          </Button>
        ) : (
          row.removable && (
            <Tooltip label={removeLabel} position="left">
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
          )
        )}
      </Group>
    </Group>
  )
}
