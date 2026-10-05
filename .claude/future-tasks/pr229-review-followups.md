# [P2] PR #229 review follow-ups: image mode check, bounded health scan

**Priority: P2 [BOTH].** The two open items from the human review of
[PR #229](https://github.com/safeinsights/canopycms/pull/229#pullrequestreview-4938780868)
(findings #7 and #8). The other review items are fixed or tracked elsewhere: the repair UI in
[duplicate-content-id-repair-ui.md](duplicate-content-id-repair-ui.md), the content-lock budget in
[content-write-lock-tuning-and-granularity.md](content-write-lock-tuning-and-granularity.md).

## 1. Browser/server `mode` mismatch is undetectable at runtime

`packages/canopycms/src/cli/template-files/Dockerfile.cms.template` (line 55) declares
`ARG NEXT_PUBLIC_CANOPY_MODE=dev`, so an image built **without** the build arg produces a
dev-mode editor bundle against a prod server: the scaffolded edit page (`edit-page.tsx.template`)
selects dev auth, and the server accepts only Clerk tokens. `operating-mode/mode-env.ts` states
that a wrong mode must fail loudly ("a typo here would silently deploy dev auth semantics"), and
the default does the opposite by construction.

Auth selection is the only client-side consequence: `supportsBranching`, `supportsStatusBadge` and
`supportsComments` return `true` in both strategies, and `supportsPullRequests` is only called
server-side.

The generated CDK stack passes `prod`, so `canopycms init-deploy aws` is fine. The exposure is the
hand-built image that `docs/deploying-to-aws.md` anticipates. An adopter image built without the
variable, whose config derived its literal as `process.env.CANOPY_MODE === 'prod' ? 'prod' : 'dev'`,
resolved `prod` on the server and `dev` in the browser with no warning, because each half's
environment agreed with its own literal. The docs now say to set `NEXT_PUBLIC_CANOPY_MODE=prod` as
a constant build value.

**Fix direction:** the server knows both halves at request time (`CANOPY_MODE` on the server; the
client bundle's belief is observable from what the editor sends). Either a one-time warning, or a
`mode` field on `/user` that the editor asserts against its own inlined value, turns a silent
misconfiguration into a diagnosable one.

**Secondary, same file:** `readModeEnv` selects the variable by `typeof window !== 'undefined'`, so
one component's SSR pass and its client pass resolve different modes whenever only one variable is
set. The invariant "both variables must agree" is unwritten and unchecked. The `/edit` page is not
guaranteed dynamic: measured on Next 15.5.21 in `apps/dual-build-fixture`, it is prerendered at
`next build` unless a server component in its tree opts out, and a `dynamic` export from the
`'use client'` edit page is ignored. A prerendered `/edit` renders on the server at build, where
`CANOPY_MODE` is unset and the `dev` literal wins, while the browser resolves `prod` from
`NEXT_PUBLIC_CANOPY_MODE`.

## 2. `branchHealth` scans every branch's whole content tree inside a 60 s Lambda

`packages/canopycms/src/branch-health.ts:123-134` (`scanDuplicateContentIds`) builds a full
`ContentIdIndex` per healthy branch, unconditionally, on every admin health request. That is N
branches times a full recursive `readdir` over EFS in one request, on a function whose default
timeout is 60 s: a deployment with a few dozen live branches and a real content tree is where the
admin panel stops loading precisely when someone is diagnosing something.

`catch { return [] }` also reports "no duplicates" for a scan that failed or timed out mid-way,
which is the wrong direction for a health check.

**Fix direction:** put the scan behind a query flag (`?duplicates=1`) or a separate endpoint, or
bound it (first N branches plus a `truncated` marker); the existing `q=`-style opt-in precedent in
this API fits. Either way, distinguish "none found" from "not determined" in the response. The
admin panel renders `duplicateContentIds` read-only (`SystemHealthPanel.tsx`), so gating the scan
means the panel passes the flag.
