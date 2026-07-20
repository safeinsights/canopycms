# Test-Gap Backfill

**Priority: P2** — from the July 2026 baseline review hygiene pass (S7): highest-risk modules over ~70 LOC with no dedicated tests. Add targeted tests opportunistically when touching these; batch the rest.

Already closed since the review: `http/router.ts` (tests added with the static-route-precedence fix, PR #85) and `validation/entry-link-validator.ts` (covered alongside PRs #88/#93).

## Remaining, roughly by risk

| Module | LOC | Why it matters |
| --- | --- | --- |
| `api/route-builder.ts` | ~289 | Endpoint definition/codegen backbone; every API surface flows through it |
| `schema/meta-loader.ts` | ~377 | Schema resolution correctness feeds validation + editor forms |
| `operating-mode/client-unsafe-strategy.ts` | ~219 | Prod-mode branch provisioning/git behavior |
| `operating-mode/client-safe-strategy.ts` | ~139 | Client-safe mode behavior |
| `settings-workspace.ts` | ~157 | Settings branch lifecycle (orphan branch, commit/push) |
| `dev-content-watcher.ts` | ~151 | Dev divergence detection |
| `api/github-sync.ts` | ~144 | PR submit path (idempotency fixed in #89; still thin on tests) |
| `authorization/groups/loader.ts` | ~123 | Group resolution feeds authz |
| `authorization/permissions/loader.ts` | ~112 | Permission resolution feeds authz |
| `user.ts` | ~118 | Auth result → CanopyUser mapping (privilege seeding) |
| `api/reference-options.ts` / `api/resolve-references.ts` | — | Editor-facing reference endpoints |
| `utils/atomic-write.ts` | ~34 | Integrity primitive everything relies on |
| `utils/provisioning-lock.ts` | ~39 | Cross-process lock primitive |

Authorization loaders, `user.ts`, and the two utils primitives are the best value-per-test — small surface, high blast radius.
