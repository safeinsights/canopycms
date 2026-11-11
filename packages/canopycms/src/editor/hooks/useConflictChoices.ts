'use client'

/**
 * The choices made on conflict cards that no save has sent yet, per entry of the open branch
 * (conflict-choices.ts). A decided choice makes its entry count as unsaved, so a save writes it,
 * and that save sends the conflict's key in `resolvedConflicts`. Choices belong to the branch they
 * were made on, and go with a discard of the entry's drafts.
 */

import { useCallback, useMemo, useRef, useState } from 'react'

import type { ResolvedFieldConflict } from '../../merge-conflicts'
import type { EntryChoices, FieldChoice } from '../conflict-choices'

interface StoredChoice {
  mergeSha: string
  choice: FieldChoice
  /** It settles its conflict, so a save resolves it. */
  decided: boolean
}

type BranchChoices = Readonly<Record<string, Readonly<Record<string, StoredChoice>>>>

const NONE: EntryChoices = {}

export interface UseConflictChoicesReturn {
  /** The open branch's choices for an entry, by conflict key. */
  choicesFor: (contentId: string) => EntryChoices
  /** Records a choice, or clears it with undefined. */
  choose: (
    contentId: string,
    key: string,
    mergeSha: string,
    choice: FieldChoice | undefined,
    decided: boolean,
  ) => void
  /** Entries with a decided choice no save has sent. */
  pendingIds: ReadonlySet<string>
  /** What a save of an entry on `branch` resolves; nothing for another branch. */
  pending: (branch: string, contentId: string) => ResolvedFieldConflict[]
  /** Drops the choices a save sent: resolved, or no longer open. */
  sent: (branch: string, contentId: string, resolved: readonly ResolvedFieldConflict[]) => void
  /** Drops an entry's choices, or every entry's when `contentId` is undefined. */
  clear: (contentId?: string) => void
  /** Keeps only the choices of the entries `open` names, which have conflicts open. */
  keepEntries: (open: ReadonlySet<string>) => void
  /** Keeps only an entry's choices for the conflicts `open` names, each on its merge. */
  retain: (contentId: string, open: ReadonlyArray<{ key: string; mergeSha: string }>) => void
}

export function useConflictChoices(branch: string): UseConflictChoicesReturn {
  const [state, setState] = useState<{ branch: string; choices: BranchChoices }>({
    branch,
    choices: {},
  })
  const choices = state.branch === branch ? state.choices : {}
  const latest = useRef({ branch, choices })
  latest.current = { branch, choices }

  // Choices are held for the open branch only: one made after a switch starts its branch afresh,
  // and a late answer about another branch leaves them alone.
  const update = useCallback(
    (forBranch: string, change: (choices: BranchChoices) => BranchChoices, starts = false) =>
      setState((prev) => {
        if (prev.branch !== forBranch) {
          return starts ? { branch: forBranch, choices: change({}) } : prev
        }
        const next = change(prev.choices)
        return next === prev.choices ? prev : { branch: forBranch, choices: next }
      }),
    [],
  )

  const choose = useCallback<UseConflictChoicesReturn['choose']>(
    (contentId, key, mergeSha, choice, decided) =>
      update(
        latest.current.branch,
        (current) => {
          const { [key]: _old, ...rest } = current[contentId] ?? {}
          const entry = choice ? { ...rest, [key]: { mergeSha, choice, decided } } : rest
          const { [contentId]: _entry, ...others } = current
          return Object.keys(entry).length > 0 ? { ...others, [contentId]: entry } : others
        },
        true,
      ),
    [update],
  )

  const pendingIds = useMemo(
    () =>
      new Set(
        Object.entries(choices)
          .filter(([, entry]) => Object.values(entry).some((c) => c.decided))
          .map(([id]) => id),
      ),
    [choices],
  )

  const pending = useCallback((forBranch: string, contentId: string): ResolvedFieldConflict[] => {
    if (forBranch !== latest.current.branch) return []
    return Object.entries(latest.current.choices[contentId] ?? {})
      .filter(([, c]) => c.decided)
      .map(([key, c]) => ({ mergeSha: c.mergeSha, key }))
  }, [])

  const sent = useCallback<UseConflictChoicesReturn['sent']>(
    (forBranch, contentId, resolved) =>
      update(forBranch, (current) => {
        const entry = current[contentId]
        if (!entry) return current
        const left = Object.fromEntries(
          Object.entries(entry).filter(
            ([key, c]) => !resolved.some((r) => r.key === key && r.mergeSha === c.mergeSha),
          ),
        )
        const { [contentId]: _sent, ...others } = current
        return Object.keys(left).length > 0 ? { ...others, [contentId]: left } : others
      }),
    [update],
  )

  const clear = useCallback(
    (contentId?: string) =>
      update(latest.current.branch, (current) => {
        if (contentId === undefined) return Object.keys(current).length > 0 ? {} : current
        if (!(contentId in current)) return current
        const { [contentId]: _cleared, ...others } = current
        return others
      }),
    [update],
  )

  const retain = useCallback<UseConflictChoicesReturn['retain']>(
    (contentId, open) =>
      update(latest.current.branch, (current) => {
        const entry = current[contentId]
        if (!entry) return current
        const kept = Object.entries(entry).filter(([key, c]) =>
          open.some((o) => o.key === key && o.mergeSha === c.mergeSha),
        )
        if (kept.length === Object.keys(entry).length) return current
        const { [contentId]: _stale, ...others } = current
        return kept.length > 0 ? { ...others, [contentId]: Object.fromEntries(kept) } : others
      }),
    [update],
  )

  const keepEntries = useCallback(
    (open: ReadonlySet<string>) =>
      update(latest.current.branch, (current) => {
        const kept = Object.entries(current).filter(([id]) => open.has(id))
        return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept)
      }),
    [update],
  )

  const choicesFor = useCallback(
    (contentId: string): EntryChoices => choices[contentId] ?? NONE,
    [choices],
  )

  return { choicesFor, choose, pendingIds, pending, sent, clear, retain, keepEntries }
}
