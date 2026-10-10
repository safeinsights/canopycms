---
priority: P2
adopters: BOTH
summary: >-
  The open item from PR #229's review: `branch-health.ts` scans every branch's whole content tree on every admin health request inside a 60 s Lambda, reporting a timed-out scan as "no duplicates"
---
# [P2] PR #229 review follow-ups: bounded health scan

**Priority: P2 [BOTH].** The open item from the human review of
[PR #229](https://github.com/safeinsights/canopycms/pull/229#pullrequestreview-4938780868)
(finding #8). The other review items are fixed or tracked elsewhere: the repair UI in
[duplicate-content-id-repair-ui.md](duplicate-content-id-repair-ui.md), the content-lock budget in
[content-write-lock-tuning-and-granularity.md](content-write-lock-tuning-and-granularity.md).

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
