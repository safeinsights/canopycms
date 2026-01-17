/**
 * API middleware helpers.
 *
 * Common guard patterns extracted from API handlers to reduce duplication.
 */

export {
  guardBranchAccess,
  guardBranchExists,
  isBranchAccessError,
  type BranchAccessResult,
  type BranchAccessSuccess,
  type BranchAccessError,
} from './branch-access'
