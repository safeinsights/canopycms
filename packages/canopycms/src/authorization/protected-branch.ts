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
import { sanitizeBranchName } from '../paths/branch'

export interface BranchProtection {
  /** True when branchName resolves to the configured base branch. */
  isProtected: boolean
  /** True when the branch must never be submitted for review (both modes). */
  submitBlocked: boolean
  /** True when the branch is read-only in the editor (prod only). */
  readOnly: boolean
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
