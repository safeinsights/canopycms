# Branch create: slow POST, and a new branch other containers cannot see yet

## Priority: P2 [BOTH]

Reported from a deployed editor: after Create Branch, nothing changed for about a minute, so
the user created again. The editor now inserts the created branch from the POST response and
switches to it immediately, shows the form in flight, and keeps the inserted branch through
stale listings for `CREATED_BRANCH_GRACE_MS` (`editor/hooks/useBranchManager.tsx`). Two
server-side halves remain, both reasoned from code rather than measured on a deployment:

1. **The POST provisions synchronously.** `createBranchHandler` (`api/branch.ts`) awaits
   `BranchWorkspaceManager.openOrCreateBranch`, which clones the workspace onto EFS under the
   provisioning lock before responding. The client switches only when that returns, so its
   latency is the user's wait. Read the deployed `createBranch` / `ensureGitWorkspace`
   `log.timed` spans (`CANOPYCMS_DEBUG`) first; if the clone dominates, decide between a
   faster clone (shared objects or a reference clone from `remote.git`) and responding before
   provisioning finishes, which would need a provisioning state on the branch the editor can
   render.
2. **Other containers can lag the new branch.** `GET /branches` served by a container other
   than the creating one can omit the branch for the NFS attribute/dentry cache window
   (docs/concurrency.md, window A). The registry carries no TTL of its own: `list()` compares
   the snapshot's token to the live generation marker, so the lag is the filesystem's. The
   client now covers the listing; it does not cover per-branch requests (entries, schema,
   comments) for the new branch that land on a lagging container. Check whether
   `getBranchContext` can miss a just-created branch there, and what the editor shows if so.

## Related

- [editor-api-latency.md](editor-api-latency.md): the per-phase timing breakdown this needs
