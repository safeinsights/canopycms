/**
 * The corrupt-`branch.json` error and what the API says about it. Free of
 * node built-ins, so the API guards, which the client bundle reaches, can
 * recognize the error without pulling in the reader (branch-metadata-file.ts).
 */

/** What the editor API answers for a branch whose branch.json is corrupt. */
export const BRANCH_METADATA_CORRUPT_MESSAGE =
  "This branch's metadata file is damaged, so the branch can't be opened or edited. An admin can repair it in System health."

/**
 * branch.json exists but is not valid JSON, or fails the schema in branch-metadata-file.ts.
 * Distinguished from provisioning and IO failures so callers can degrade instead
 * of failing hard: the registry scan quarantines the branch, the API answers
 * {@link BRANCH_METADATA_CORRUPT_MESSAGE}, and the request handler keeps serving
 * (with empty internal groups) when the BASE branch is the corrupt one —
 * otherwise the admin recovery surface is unreachable exactly when it is needed.
 */
export class BranchMetadataCorruptError extends Error {
  readonly branchRoot: string
  /**
   * [REDACT] What is wrong with the file, with no embedded path: the JSON.parse
   * failure, or the fields that failed the schema.
   * `message` above keeps the `branchRoot`-qualified text for server logs;
   * `parseCause` is the one callers surface to clients (branch-health.ts's
   * `parseError`), so no scan leaks the absolute workspace path.
   */
  readonly parseCause: string

  constructor(branchRoot: string, cause: string) {
    super(`Corrupt branch metadata in '${branchRoot}': ${cause}`)
    this.name = 'BranchMetadataCorruptError'
    this.branchRoot = branchRoot
    this.parseCause = cause
  }
}
