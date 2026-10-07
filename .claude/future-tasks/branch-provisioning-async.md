# Provision branch workspaces outside the create request

## Priority: P2 [BOTH]

Branch create clones the workspace inside the `POST /branches` request
(`branch-provisioning.ts`). That is now fast and crash-safe:

- `remote.git` is kept packed;
- one clone and one parallel checkout;
- a sparse cone for content branches;
- staging plus publish-by-rename, so a kill leaves nothing that blocks a retry.

But it is still bounded by the request timeout, and its cost grows with repo size. The per-step
`provision … step=…` log lines show where the time goes on a deployment. Build this when they show
creates near the timeout, or when an adopter repo is large enough that the sparse checkout alone is
slow.

## Design: fail-safe by construction

The work item lives in a durable record. Never require two writes to land together, such as a
record write followed by an enqueue.

- **One commit point.** `POST /branches` atomically writes a provisioning record (temp + rename)
  and returns. A kill before the rename leaves nothing, and the user retries. A kill after it
  leaves a record the worker will act on.
- **Level-triggered worker.** Each sync cycle, the worker scans records and works every one it can
  claim. An enqueued task is only a latency nudge, so losing it costs one cycle, not correctness.
- **Expiring claims.** The worker claims a record with the provisioning lock, which already
  recovers stale holders. The build itself is today's staged build plus publish
  (`stageBranchWorkspace` / `publishStaging`), so a dead worker leaves only a sweepable
  `.prov-*`.
- **Bounded attempts.** The record carries an attempt count and the last error. After N failures
  it becomes `failed`, with a reason the editor shows, and offers retry and delete.

## Where the state must be visible

Most of this is one choke point plus a few specific places, not every endpoint:

- **Branch-context resolution** (the `branchContext` guard → `getBranchContext`) returns `409
  {provisioning}` for a provisioning branch instead of cloning it in-request. Every branch-scoped
  route inherits this. First verify that every branch-scoped route really goes through that guard.
- **`GET /branches`** lists provisioning records with their status (the registry lists only
  directories with `branch.json`).
- **A poll endpoint** (`GET /:branch/status`, or the list) returns `provisioning | ready | failed`
  plus the reason.
- **`DELETE /:branch`** cancels or cleans up a provisioning branch.
- **Admin branch-health** does not classify an in-flight provision as an orphan.
- **The editor** polls after create and holds its branch-scoped data hooks until the branch is
  ready.

## Related

- [branch-provisioning-warm-spares.md](branch-provisioning-warm-spares.md): makes the in-request
  create about 1 s at any repo size. Cheaper than this, and may remove the need for it.
- [branch-create-latency-and-cross-container-visibility.md](branch-create-latency-and-cross-container-visibility.md)
