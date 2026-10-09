---
priority: P3
adopters: BOTH
summary: >-
  Targeted tests for modules with no direct test: `api/route-builder.ts`, `authorization/groups/loader.ts`, `user.ts`, `utils/atomic-write.ts`. The earlier operating-mode slice is dropped: `operating-mode/__tests__/strategies.test.ts` covers both strategies
---
# Test-Gap Backfill

**Priority: P3 [BOTH].** Add targeted tests opportunistically when touching these modules; batch the rest.

## Remaining

None of these has a test that imports it directly.

| Module                       | Why it matters                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `api/route-builder.ts`       | Endpoint definition and codegen backbone; every API surface flows through it                    |
| `authorization/groups/loader.ts` | Group resolution feeds authz                                                                |
| `user.ts`                    | Auth result to `CanopyUser` mapping (privilege seeding)                                         |
| `utils/atomic-write.ts`      | Integrity primitive everything relies on                                                        |

The authorization loader, `user.ts` and `atomic-write.ts` are the best value per test: small surface, high blast radius.
