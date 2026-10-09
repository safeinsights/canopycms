# Future Tasks Index

Every task file starts with frontmatter that is the record of its priority and summary:

```yaml
---
priority: P2
adopters: BOTH
summary: >-
  One or two sentences: what is wrong or missing, and the proposed fix
---
```

`priority` is P0 to P3, `adopter-side` (work the adopter schedules in its own repo) or `program`.
`adopters` is optional: KB, MKT, BOTH or NEITHER. A resolved file needs only `summary`.

- **P0** — Blocks production launch; data loss, security, or crash
- **P1** — Significant correctness issue under normal use; important quality debt
- **P2** — Useful enhancement, moderate quality improvement, or feature work
- **P3** — Nice-to-have; low-impact

This file holds only what is ranked by hand. For every task by priority, plus the resolved ones,
run `pnpm tasks:index`. Filing a task is adding its file; resolving one is `git mv` into
[resolved/](resolved/) with its summary rewritten as `RESOLVED <date>, <branch>. <what shipped>`.
Neither edits this file unless the task is in a ranked list below.

**Who this backlog is serving right now:** the **marketing site** runs a deployed editor on a
sandbox tier (Lambda + EFS + worker, Clerk, group path rules, `trailingSlash: true`). Its production
go-live comes next: shared-package extraction, then the official accounts (each tier gets its own
editor), a content pass, and the DNS cutover, at which point the editor's base branch becomes
`production`. The **knowledge base** follows on the same shape. A task's `adopters` names which of them it
serves; prod-shape work is `BOTH` by default.

Check each adopter's lockfile for the `canopycms` version it pins; this index carries no version pins.

The marketing site keeps a running log of package bugs and gaps it hits, re-verified
per release against the installed tarball. It is the closest thing we have to an
external adopter's view of this package — see
[adopter-request-log-intake.md](adopter-request-log-intake.md) for what it contains and
how items from it get triaged in.

---

## Do next — ranked

A single ordered list across priorities, mixing fixes and features. Priority answers "how bad"; this
answers "what now". Each item's detail is in its file.

| # | Item | Why now |
| - | ---- | ------- |
| 1 | Worker-down observability: [worker-not-ready-permanent-failure.md](worker-not-ready-permanent-failure.md), [worker-secret-errors-before-start-are-invisible.md](worker-secret-errors-before-start-are-invisible.md), [worker-boot-loop-alarming.md](worker-boot-loop-alarming.md) | A worker that fails at boot leaves editors on "starting…" forever, with no reason in System health and no page. In production nobody is watching the sandbox console. |
| 2 | [mdx-preview-executes-editor-code.md](mdx-preview-executes-editor-code.md) | The marketing site renders MDX bodies with `evaluate`, and its only defence is a `validateEntry` hook that refuses executable MDX by entry type (which now always receives the resolved type). Decide the trust model and whether a save-time "no expressions" schema option belongs in the package. |
| 3 | [authorization-enforcement-consolidation.md](authorization-enforcement-consolidation.md) (comments slice) | A real editorial team means path rules that matter. Comment threads are the read path that ignores path rules. |
| 4 | [branch-registry-corrupt-snapshot.md](branch-registry-corrupt-snapshot.md) and [branch-metadata-no-schema-validation.md](branch-metadata-no-schema-validation.md) | Cheap. A corrupt EFS JSON file currently bricks branch listing for everyone, or reaches guards unvalidated. |
| 5 | Release readiness (JP's calls): the live first-mount probe on the first prerelease carrying MDXEditor 4.3 ([turbopack-import-cycle-double-evaluation.md](turbopack-import-cycle-double-evaluation.md)), then `int-202610-b` → `main` and a stable release before the first official-account editor deploy | The jsx import cycle survives 4.3.2, so only the live probe shows the Turbopack crash is still contained. A production editor should not pin an `int` prerelease. |
| 6 | Deploy verification sweep: [infra-review-2026-08-deploy-verification.md](infra-review-2026-08-deploy-verification.md), the live Clerk proof in [clerk-signed-out-followups.md](clerk-signed-out-followups.md), the plaintext-secret check in [deploy-test-lambda-plaintext-clerk-secret.md](deploy-test-lambda-plaintext-clerk-secret.md), and the deployed timing breakdown in [editor-api-latency.md](editor-api-latency.md) | A real stack exists and none of these has a recorded result. Run them on the sandbox tier before the official accounts copy its shape; two of the infra checks fail silently. Needs AWS access. |
| 7 | [submission-editor-tracking.md](submission-editor-tracking.md) and [audit-logging.md](audit-logging.md) phase 1 | The submitter is recorded; who saved each edit, and who changed an ACL rule, are not. Both matter once more than one person edits. |
| 8 | [occ-lock-compromise-silent-in-prod.md](occ-lock-compromise-silent-in-prod.md) and [save-conflict-notification-discards-message.md](save-conflict-notification-discards-message.md) | Two cheap fixes that tell operators and editors the truth when EFS locking or OCC fires. |
| 9 | Next-site setup traps: [prod-remote-default-branch-detection.md](prod-remote-default-branch-detection.md), [example-aws-deployment-drift-from-template.md](example-aws-deployment-drift-from-template.md), the Dockerfile mode ARG in [pr229-review-followups.md](pr229-review-followups.md), [live-site-acl-migration.md](live-site-acl-migration.md) | Fix these before the official accounts and the KB deploy on the same shape; each one misconfigures a deploy silently, and the cutover moves the base branch to `production`. |
| 10 | [pr229-review-followups.md](pr229-review-followups.md) (bounded health scan), [duplicate-content-id-repair-ui.md](duplicate-content-id-repair-ui.md), [user-metadata-optimization.md](user-metadata-optimization.md) | Admin surfaces on the live site: a health scan that times out reads as "no duplicates", and the Permission and Groups panels fire one Lambda call plus one Clerk call per badge. |
| 11 | [block-value-null-or-array-breaks-resolution.md](block-value-null-or-array-breaks-resolution.md) and [remote-git-self-heal.md](remote-git-self-heal.md) | One-line fix for a "permanently unopenable entry" after merges; recovery from a poisoned `remote.git` still needs an EFS shell. |

---

## Active program

The production-readiness program's hub is [production-readiness-program.md](production-readiness-program.md)
(status, decisions, protection rules), with [program-log.md](program-log.md) as its append-only log.
Workstreams A to C are done and D to F are retired (the first deployed editor went live 2026-10-05); G
is the open one, a normal P2 task.

---

## Deferred from 2026-04 baseline review (minor)

Small findings not worth dedicated task files; fix opportunistically:

- `MediaConfig` is hand-written rather than `z.infer`red from `mediaSchema`, so TS and Zod can disagree and nothing catches it — `config/types.ts:203-216` vs `config/schemas/media.ts` (still open; citation corrected 2026-09-10, and the s3 variant gained a third field, `uploadUrl`, to keep in sync by hand). Originally filed as "publicBaseUrl accepts any string in TS but Zod enforces URL format"
- `listAssets` endpoint has no auth guard beyond the handler-level authn check — promoted out of this list 2026-07-30 into [asset-listing-cross-branch-exposure.md](asset-listing-cross-branch-exposure.md), which records the full audit and the decision taken
- Container-only collections (no `entries`) are create-then-uneditable via direct API: first write falls back to filename type `entry`, subsequent writes resolve that on-disk type and `store.write` 400s. Editor never hits it; fold into assets/media or content-store work. (2026-07 second-round review, LOW)
- `assets.upload` can never validate: server schema requires a `Buffer`/`Uint8Array` instance but the client JSON-stringifies bodies, so the parsed value is a plain object → always 400. Dead path today; rework with the assets/media system. (2026-07 second-round review, LOW)

Fixed on the 2026-07 review branch: `CanopyConfigSchema` schema-field drift, `relativePathSchema` per-segment traversal check, `composeCanopyConfig` dead spread (superseded by the full-fragment merge in PR #90). The getErrorMessage sweep (G1) replaced the exact-semantic `String(err)` occurrences; sites with custom fallback strings or raw-object console logging were deliberately retained.

---

## Related documents

- [../../BACKLOG.md](../../BACKLOG.md) — the **unranked feature roadmap** (capabilities we may want). This index is for defects, debt and deferred fixes, with severities. Audited 2026-08-13: roughly half of BACKLOG's items are completion records; its item numbering is load-bearing (`api/entries.ts:249` cites "BACKLOG #19")
- [../../apps/test-app/e2e/COVERAGE-MATRIX.md](../../apps/test-app/e2e/COVERAGE-MATRIX.md) — what e2e covers, per capability
- `apps/test-app/e2e/E2E-BACKLOG.md` — **largely superseded**; audited 2026-08-13 and marked up in place. Items 1–13, 19 and 20 are covered by real tests; 15/16 are feature requests, not test gaps; 17/18a are triple-tracked here and in the coverage matrix
