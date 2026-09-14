/**
 * Protected base branch predicate: the single source of truth other modules
 * key off of — do not re-derive the comparison elsewhere.
 *
 * The base branch (the PR base, usually `main`) can never be submitted for
 * review in either mode, since submitting it would push straight to itself and
 * bypass review, and is read-only in the editor in prod only — dev needs it
 * editable (see ARCHITECTURE.md "Protected Base Branch").
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
   * moved past `'editing'` (locked while its PR is under review), or its
   * status could not be read at all.
   */
  writeBlocked: boolean
  /**
   * True when the branch can never be submitted for review, for EITHER
   * reason: it is the protected base branch (`protection.submitBlocked`), or
   * its workflow status has moved past `'editing'` (already submitted,
   * approved, or archived -- or unreadable, which fails closed the same way
   * `writeBlocked` does: `status !== 'editing'` is true when `status` is
   * `undefined`).
   *
   * NOT named `submitBlocked`: `BranchProtection.submitBlocked`, the field
   * this type inherits, means ONLY "this is the base branch", and
   * `api/guards.ts`'s `submittableBranch` guard depends on that narrow
   * meaning, so the compound answer gets a distinct name.
   *
   * It also differs from `writeBlocked`: in dev the base branch is writable
   * but never submittable, so the two fields disagree there.
   */
  submitBlockedIncludingStatus: boolean
}

/**
 * Whether `branchName` is the protected base branch for `config`.
 *
 * The comparison is sanitization-aware: branch metadata names are sanitized but
 * `config.defaultBaseBranch` holds the raw git name, so both sides go through
 * `sanitizeBranchName` first.
 *
 * `recordedBaseBranch` (a branch's own recorded fork point) is a second, purely
 * additive clause: a branch whose fork point equals its own name IS a base
 * workspace whatever `config.defaultBaseBranch` says now. In dev that config
 * value tracks live git HEAD (`refreshActiveBranch`) and can drift, and without
 * this clause the drift would silently un-protect the branch the base workspace
 * was forked from; a normal branch (`baseBranch !== name`) is never falsely
 * protected.
 *
 * Answers base-branch questions only (submit/delete/ACL rails). To authorize a
 * content write or render a lock, use {@link getBranchWriteProtection}, which
 * also accounts for workflow status.
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
 * {@link getBranchProtection} plus the write decision: writes are blocked on
 * the read-only base branch and on any branch whose status has left
 * `'editing'` -- the single expression of that rule, read by the API guard, the
 * branches-list wire flag and the editor.
 *
 * `status` is REQUIRED and admits `undefined` because a missing status must
 * FAIL CLOSED: `branch.json` is read with a bare `JSON.parse(...) as
 * BranchMetadataFile` (branch-metadata.ts), so it can be absent at runtime.
 * Required, not optional, so "argument omitted" and "file had no status" stay
 * distinguishable -- the safe answer differs.
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
    // Base-branch half is `protection.submitBlocked` (isProtected, BOTH
    // modes) -- not `protection.readOnly` (PROD only) -- because submit is
    // never valid on the base branch even in dev, where it stays writable.
    // See the field's own doc comment on BranchWriteProtection for the
    // asymmetry this produces against `writeBlocked` and why the name is
    // deliberately verbose.
    submitBlockedIncludingStatus: protection.submitBlocked || status !== 'editing',
  }
}
