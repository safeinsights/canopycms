/**
 * Protected base branch predicate.
 *
 * The base branch (the PR base — usually `main`) can never be submitted for
 * review (both modes: submitting it would push straight to itself, bypassing
 * review) and is read-only in the editor in prod (dev needs the base branch
 * editable since the developer always lands there — see ARCHITECTURE.md
 * "Protected Base Branch"). This is the single source of truth other modules
 * key off of; do not re-derive the comparison elsewhere.
 */

import type { CanopyConfig } from '../config'
import type { BranchStatus } from '../types'
// branch-name, NOT branch: this module is client-reachable (editor bundle →
// api/guards.ts → here), and paths/branch.ts drags node:fs into the graph,
// which breaks adopters' production `next build`.
import { sanitizeBranchName } from '../paths/branch-name'

export interface BranchProtection {
  /** True when branchName resolves to the configured base branch. */
  isProtected: boolean
  /** True when the branch must never be submitted for review (both modes). */
  submitBlocked: boolean
  /** True when the branch is read-only in the editor (prod only). */
  readOnly: boolean
}

/**
 * {@link BranchProtection} plus the write decision, which additionally depends
 * on the branch's workflow status. Produced only by
 * {@link getBranchWriteProtection}, so a caller that never supplied a status
 * cannot read a `writeBlocked` that would silently mean "not checked".
 */
export interface BranchWriteProtection extends BranchProtection {
  /**
   * True when content writes must be rejected, for ANY of three reasons: the
   * branch is the read-only protected base branch, its workflow status has
   * moved past `'editing'` (locked while a reviewer looks at its PR), or its
   * status could not be read at all.
   */
  writeBlocked: boolean
}

/**
 * Determine whether `branchName` is the protected base branch for `config`.
 *
 * Comparison is sanitization-aware: branch metadata names are sanitized
 * (`sanitizeBranchName`) but `config.defaultBaseBranch` holds the raw git
 * name, so both sides are sanitized before comparing.
 *
 * `recordedBaseBranch` (a branch's own `baseBranch` field, i.e. its recorded
 * fork point) is an additional, independent protection clause: a branch whose
 * fork point equals its own name IS a base workspace, regardless of what
 * `config.defaultBaseBranch` says right now. This matters because in dev
 * mode, `config.defaultBaseBranch` tracks live git HEAD (`refreshActiveBranch`)
 * and can drift to a different branch after the base workspace was created --
 * without this clause, that drift would silently un-protect the branch the
 * base workspace was actually forked from. The clause is purely additive: it
 * only ever adds protection the config clause didn't already grant, so a
 * normal editing branch (`baseBranch !== name`) is never falsely protected.
 *
 * This answers base-branch questions only (submit/delete/ACL rails). To
 * authorize a content write or render a lock, use
 * {@link getBranchWriteProtection}, which also accounts for workflow status.
 */
export function getBranchProtection(
  config: Pick<CanopyConfig, 'mode' | 'defaultBaseBranch'>,
  branchName: string,
  recordedBaseBranch?: string,
): BranchProtection {
  const sanitizedName = sanitizeBranchName(branchName)
  const isProtected =
    sanitizedName === sanitizeBranchName(config.defaultBaseBranch ?? 'main') ||
    (recordedBaseBranch !== undefined && sanitizedName === sanitizeBranchName(recordedBaseBranch))

  return {
    isProtected,
    submitBlocked: isProtected,
    readOnly: isProtected && config.mode === 'prod',
  }
}

/**
 * {@link getBranchProtection} plus the write decision: writes are blocked on the
 * read-only base branch, and on any branch whose status has left `'editing'`.
 * This is the single expression of the "which statuses lock editing" rule --
 * the API guard, the branches-list wire flag, and the editor all read it here.
 *
 * `status` is REQUIRED, and deliberately typed to admit `undefined`, because a
 * missing status must FAIL CLOSED. `branch.json` is read with a bare
 * `JSON.parse(...) as BranchMetadataFile` (branch-metadata.ts) with no schema
 * validation, so a hand-repaired or partially-written file can yield
 * `status: undefined` at runtime even though the type says otherwise -- and
 * malformed branch metadata is a real, handled condition here (see the
 * corrupt-metadata quarantine in branch-registry/branch-health). A branch whose
 * review state cannot be determined must not be writable.
 *
 * Requiring the parameter is the point: an optional one would make "caller
 * omitted it" and "the file had no status" indistinguishable, and the safe
 * answer differs between them. Callers that genuinely don't care about status
 * call {@link getBranchProtection} instead and get no `writeBlocked` at all.
 */
export function getBranchWriteProtection(
  config: Pick<CanopyConfig, 'mode' | 'defaultBaseBranch'>,
  branchName: string,
  recordedBaseBranch: string | undefined,
  status: BranchStatus | undefined,
): BranchWriteProtection {
  const protection = getBranchProtection(config, branchName, recordedBaseBranch)

  return {
    ...protection,
    // `undefined !== 'editing'` is true, so an unreadable status blocks writes.
    writeBlocked: protection.readOnly || status !== 'editing',
  }
}
