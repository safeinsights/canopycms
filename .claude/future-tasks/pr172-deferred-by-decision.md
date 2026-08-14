# PR #172's two deferred-by-decision findings

## Priority: P3

Split out of [pr172-review-followups.md](resolved/pr172-review-followups.md) on
2026-08-13, when the other seven of that review's nine findings were fixed (PRs
#223, #224, #226, #227) and the record moved to `resolved/`. These two were
deferred **by decision, not oversight**. Both re-verified live at `78e4ca8b`.

## #5 — `workflow_dispatch` publishes signed npm artifacts from unreviewed code

`publish.yml:161-163` routes a manual dispatch to the `prerelease` job on
`if: github.event_name == 'workflow_dispatch'` alone. The only other gate is
`publish-prerelease.yml:43`'s `GITHUB_REF != refs/heads/main`. There is no
`environment:` block.

Everything else — the source, `pnpm install --frozen-lockfile` against that
branch's lockfile, the five `prepack` builds — comes from a branch that by
construction has not been reviewed, and the artifacts carry a valid provenance
attestation. Stated plainly: **main's branch protection does not bound what
reaches npm.**

**JP's call, 2026-08-13: log as future work, not a current concern.** This is a
risk-acceptance question about how open the `int` channel should be, not a
defect. If it is ever to be bounded, the lever is a GitHub `environment:` with
required reviewers on the `prerelease` job — roughly one line.

## #8 — `setBusy` is a shared boolean with concurrent writers and no ref-count

`editor/Editor.tsx:312` and `:370` both pass `setBusy: setEntriesLoading`, so
`useEntryManager` and `useDraftManager` write the same flag. `useEntryManager.ts:642`
mirrors SWR's `entriesIsValidating` onto it **unconditionally**, while the other
writers bracket it manually. Last writer wins, so a revalidation settling
mid-save clears the save's busy state.

Self-correcting within a render or two, so this is spinner flicker rather than a
correctness problem. But the contract the comment at `:640` describes — "callers
that need a busy indicator around an explicit refresh already bracket `setBusy`
themselves" — is one the unconditional effect cannot honor. A small
`beginBusy`/`endBusy` counter would make it hold.

Deliberately not folded into the editor state-machine PR, which had already
landed and been CI-verified.

## Related

- [editor-state-context-migration.md](editor-state-context-migration.md) — the
  natural home for #8 if the editor state work is picked up again
- [document-release-process.md](document-release-process.md) — #5's channel is
  half of what that doc needs to describe
