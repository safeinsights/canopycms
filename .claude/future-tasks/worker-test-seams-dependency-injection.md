# [P2] Worker tests reach through instances; inject collaborators instead

**Status:** Open. Deferred by decision on 2026-09-13 from the baseline-quality epic
([baseline-quality-202609.md](baseline-quality-202609.md)), whose encapsulation PR tags
remaining test seams `@internal` but does not redesign them.

## Evidence (measured 2026-09-13 in `packages/canopycms/src`)

- 51 instance-method replacements in tests, 100 `vi.spyOn` calls, 166 `as unknown as`
  casts, and 18 `*ForTesting` seams.
- `packages/canopycms/src/worker/worker-context.ts` documents an interface whose shape
  exists so tests can monkey-patch `CmsWorker`.
- The ten `packages/canopycms/src/worker/cms-worker*.test.ts` files replace instance
  methods on the worker under test, so each test pins the class's internal call graph
  rather than its behavior, and a refactor that keeps behavior breaks the suite.

## Fix shape

- Inject `octokit`, the GitHub URL builder and the push function through `CmsWorker`
  constructor options, with defaults that produce today's behavior.
- Tests pass fakes through those options and stop replacing instance methods; delete
  each `*ForTesting` seam that then has no caller.
- Production call sites stay unchanged; the ten `cms-worker*.test.ts` files are the
  migration surface. Land it as one PR per collaborator so each step keeps the suite
  green.

## Out of scope

Seams in other packages, and `vi.spyOn` on module exports outside `worker/`.
