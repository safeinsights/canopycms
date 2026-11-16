import type { BranchContext } from '../types'
import type { AuthPlugin } from '../auth/plugin'
import type { CanopyServices } from '../services'
import type { CanopyUser } from '../user'
import type { BranchAccessRefusalCode } from '../authorization/branch-sharing'
import type { AssetStore } from '../assets/types'
import type { CanopyRequest } from '../http/types'

export interface ApiContext {
  services: CanopyServices
  assetStore?: AssetStore
  /**
   * Load a branch context for the requested branch name.
   * Can be backed by BranchRegistry + BranchMetadataFileManager.
   *
   * @param options.loadSchema - If true, loads per-branch schema into context.flatSchema
   */
  getBranchContext: (
    branchName: string,
    options?: { loadSchema?: boolean },
  ) => Promise<BranchContext | null>
  authPlugin?: AuthPlugin
}

export interface ApiRequest<TBody = unknown> {
  branch?: string
  body?: TBody
  query?: Record<string, string | string[] | undefined>
  user: CanopyUser
  /**
   * The underlying framework-agnostic request, for handlers that must bypass
   * the default JSON body parsing (e.g. multipart/form-data uploads - see
   * `bodyFormat: 'multipart'` in route-builder.ts and `rawRequest.formData()`
   * / `rawRequest.rawBody()`). Always populated by the core handler; optional
   * only so hand-built `ApiRequest` test fixtures that don't need it keep
   * compiling.
   */
  rawRequest?: CanopyRequest
}

export interface ApiResponse<TData = unknown> {
  ok: boolean
  status: number
  data?: TData
  error?: string
  /**
   * Structured per-field validation errors accompanying a 422 rejection
   * (schema validation at the content write boundary). `fieldPath` uses the
   * canonical CanopyCMS path format (e.g. `blocks[0].title`) so the editor can
   * surface each error next to its form field.
   */
  fieldErrors?: Array<{ fieldPath: string; message: string }>
  /** A machine-readable reason for some failures; see {@link ApiErrorCode}. */
  code?: ApiErrorCode
  /** The users or groups a refused access change names, from among those it sent. */
  ids?: string[]
}

/**
 * `SCHEMA_UNAVAILABLE`: the entry's type names an entry schema the running code lacks (a 503,
 * see `SchemaUnavailableError`). `WORKER_FAILED`: the CMS worker recorded that its latest start
 * failed, so a retry will not help until an admin fixes it (a 503 with no `Retry-After`).
 * `WRITE_OUTCOME_UNKNOWN`: an entry save ran but lost its branch lock mid-write, so it may have
 * landed (a 409); the version the caller holds may be stale, so it must re-read before retrying.
 * `ENTRY_GONE`: an entry update found no file, because the entry was deleted or moved since the
 * caller read it (a 409); it was not saved, and only a create can bring the entry back. A
 * resolve-entry answers it too, for an entry no longer where its conflict was shown.
 * `EDITOR_MODE_MISMATCH`: the editor bundle was built for the other operating mode than the
 * server runs (a 412, see operating-mode/editor-mode-check.ts); only a rebuild fixes it.
 * `SETTINGS_CHANGED`: a groups or permissions save named a version the file has moved on from (a
 * 409, see `SettingsVersionConflictError`); nothing was saved, and a reload shows the other edit.
 * The other settings 409, a busy file lock, carries no code. `BRANCH_SYNCING`: an entry save was
 * refused because the branch is mid-rebase (a 409); nothing was saved, and a retry soon can pass.
 * `BRANCH_NAME_REFUSED`: a branch create was refused for the name it gave (a 400 or 409), so only
 * another name can pass; no other create failure carries it. `OPEN_CONFLICTS`: a submit or approval
 * was refused while a merge's conflicts are open on the branch (a 409, merge-conflicts.ts).
 * `CONFLICT_CHANGED`: a resolve-entry named a conflict the record no longer holds as shown (a 409);
 * re-read the branch's conflicts. `BRANCH_MOVED`: an approval or a request for changes named a commit
 * other than the branch's head, or none (a 409, api/branch-review.ts); reload the branch first.
 * `BRANCH_ACCESS_DENIED` / `BRANCH_LOCKED_DOWN`: the caller may not open the branch, or an admin has
 * locked it to admins and reviewers (a 403). The access-list codes (`BRANCH_ARCHIVED`,
 * `BRANCH_NOT_SHAREABLE`, `USER_NOT_FOUND`, `USER_OUT_OF_SCOPE` and
 * {@link BranchAccessRefusalCode}) refuse a change to who may open a branch (api/branch-access.ts);
 * the list is unchanged. `LIST_CHANGED`: another change to the list landed while this one was
 * saved (a 409), so a retry can pass. `RATE_LIMITED`: the caller made too many email lookups while finding
 * people (a 429, api/people.ts); a retry in a few minutes can pass. `BRANCH_CREATE_FORBIDDEN`: the
 * caller may not create branches (a 403), so only a path permission that lets them edit can pass.
 */
export type ApiErrorCode =
  | 'SCHEMA_UNAVAILABLE'
  | 'WORKER_FAILED'
  | 'WRITE_OUTCOME_UNKNOWN'
  | 'ENTRY_GONE'
  | 'EDITOR_MODE_MISMATCH'
  | 'SETTINGS_CHANGED'
  | 'BRANCH_SYNCING'
  | 'BRANCH_NAME_REFUSED'
  | 'OPEN_CONFLICTS'
  | 'CONFLICT_CHANGED'
  | 'BRANCH_MOVED'
  | 'BRANCH_ACCESS_DENIED'
  | 'BRANCH_LOCKED_DOWN'
  | 'BRANCH_ARCHIVED'
  | 'BRANCH_NOT_SHAREABLE'
  | 'USER_NOT_FOUND'
  | 'USER_OUT_OF_SCOPE'
  | 'LIST_CHANGED'
  | 'RATE_LIMITED'
  | 'BRANCH_CREATE_FORBIDDEN'
  | BranchAccessRefusalCode
