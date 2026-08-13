# Baseline review 2026-08: follow-ups discovered while implementing the fixes

These were not review findings. Each was found by a worker while fixing something else, and
filed rather than folded in, so the PR under way stayed scoped. Recorded here because the
implementation session's own context is not durable — the repo is.

Epic: `integration-202608-a`, branched from `integration-202607-a` @ `bfe76e1e`. See
[REVIEW-REPORT-2026-08.md](../../REVIEW-REPORT-2026-08.md) for the findings themselves and
[pr172-review-followups.md](pr172-review-followups.md) for the human review's nine.

Findings are struck ~~in place~~ as they resolve.

---

## 1. [P2] The mock-services fixture is copy-pasted across four test files

Found while fixing the split-brain group storage. `http/handler.test.ts`,
`http/handler-binary.test.ts`, `http/handler-context-retry.test.ts` and `api/assets.test.ts`
each carry their **own independent copy** of the same `createMockServices()` / `minimalServices()`
object — one of them commented as "mirroring `http/handler.test.ts`'s `createMockServices()`".

The cost is not hypothetical: adding a single dependency to the real request pipeline
(`getSettingsBranchRoot`, when internal groups moved to the settings workspace) broke **five tests
across three of those files**, and each needed the same edit made separately. The worker that made
the change ran only its own targeted files and reported green; a different worker on unrelated
code found the failures. That is the shape this will keep taking — a pipeline change is
invisible to whichever copies the author didn't happen to run.

**Fix direction:** one shared fixture factory (`api/__test__/` already exists as a home) that every
handler-pipeline suite imports, with per-test overrides layered on top. The point is that adding a
service to the pipeline should require **one** edit and then fail loudly everywhere until it is
made — not four edits that can each be forgotten independently.

---

## 2. [P3] `rich-text` is redundant with `markdown`/`mdx` — decide whether the type should exist

Found while implementing the missing field renderers. `rich-text` is declared in
`config/types.ts`'s `primitiveFieldTypes` and is now rendered (it reuses `MarkdownField`, so it is
no longer a dead end), but reading the code shows nothing anywhere distinguishes it:

- `validation/entry-validator.ts`'s `STRING_FIELD_TYPES` treats `markdown`, `mdx` and `rich-text`
  identically;
- `validation/entry-link-validator.ts`'s scan treats them identically;
- `ai/json-to-markdown.ts`'s rendering treats them identically.

So it is a third name for a behavior that already has two. It is now functional rather than
broken, which is why this is P3 rather than blocking — but a public field type whose semantics are
indistinguishable from its neighbours is a question an adopter will eventually ask, and the answer
should be decided rather than inherited.

**Decide:** either give it distinguishing behavior, or deprecate it from the public `fieldTypes`
surface (a breaking-ish change, so it wants a deliberate call and probably a release note).

---

## 3. [P3] Sibling confirmation modals lack the testids their e2e helpers may want

Found when CI's e2e caught the new delete confirmation. `branch-page.ts`'s `deleteBranch` helper
already looked for `[data-testid="confirm-delete-branch"]`, so the new modal opened with nothing to
dismiss it and the spec timed out three times over.

Fixed for delete. The sibling confirmations — `showSubmitConfirmation` and
`showWithdrawConfirmation` in `editor/hooks/useBranchManager.tsx` — still pass only
`confirmProps: { color: … }` with no testid. They are not currently broken, because their specs
reach them another way, but the asymmetry means the next e2e helper written against them will hit
the same wall.

**Fix direction:** give all three confirmations stable testids, and prefer that selector in the e2e
fixtures over role/text matching, which is brittle against copy changes.

---

## 4. [P3] Unit tests cannot catch modal-driven UX changes, by construction

Not a defect — a coverage-shape note worth having written down, since it cost a CI round trip.

`FormRenderer.test.tsx` and the editor hook suites mock `@mantine/modals` wholesale
(`modals: { openConfirmModal: vi.fn() }`). That is the right call for unit tests, but it means
**adding, removing or re-labelling a confirmation is structurally invisible to them** — the mock
absorbs it and the assertions still pass.

Consequence for planning: any change that introduces or alters a confirmation dialog should be
assumed to need an e2e update, and should not be batched onto the integration branch without a
per-PR e2e run. This epic's per-fix CI gating is what caught it; batching would have merged it.
