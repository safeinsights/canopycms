# [P2] The release pipeline has no CI gate, can wedge mid-publish, and runs unpinned actions

Three findings from the 2026-08-20 three-round infrastructure review (rounds 1
and 2), at HEAD `7881e489`. Round 3 verified #1 against the **live repo config**
with read-only `gh api` — it is real end to end, not compensated by branch
protection.

Overlaps by subject, not by content, with
[document-release-process.md](document-release-process.md) (nothing describes
either publish channel) and [pr172-deferred-by-decision.md](pr172-deferred-by-decision.md)
#5 (`workflow_dispatch` publishing from unreviewed branches). Do them together.

## 1. publish.yml claims "only run after CI passes" — no such mechanism exists

`.github/workflows/publish.yml:26-27` carries the comment "Only run after CI
passes (CI also runs on push to main)" on an `if: github.event_name == 'push'`.
CI and publish are separate workflows that both trigger on push to main and run
**concurrently**. There is no `workflow_run` gate, no cross-workflow `needs` (GitHub
Actions cannot express it), and no status check.

**Round 3 confirmed the gap end to end**: the live repo has no ruleset requiring
any status check, so a PR whose CI is red or still in flight can merge, and
publish.yml ships it.

**Scenario.** Two PRs that each pass CI individually merge in quick succession;
the combined state on main fails CI (classic merge skew — an API rename in one, a
new call site in the other). CI on the merge commit goes red. publish.yml,
already running in parallel, builds — and build ≠ the test suite, it runs no
tests at all — then publishes all five packages to the `latest` dist-tag with
provenance. Adopters `npm install` a version whose own CI never passed. Same
story for a direct admin push to main.

**Fix direction.** Trigger publish via `workflow_run` on CI's completion with a
`conclusion == 'success'` guard — keeping the same filename, so npm trusted
publishing keeps working — or have the publish job assert the commit's check-run
state before the first `npm publish`. Requiring status checks on main is the
complementary half.

## 2. A superseding push cancels a stable publish mid-way and wedges the release train

`publish.yml:14-20` sets `cancel-in-progress: ${{ github.event_name == 'push' }}`.
The workflow itself documents, for prereleases, that "a run killed part-way
through the five publishes would move the tag for some packages and not others,
leaving adopters on a mismatched set" — and then enables exactly that for the
stable channel.

It is worse than a mismatched set. The version-bump commit lands only *after* all
five publishes (`:116-157`), so a cancellation — or a non-fast-forward failure of
the final `git push` when main advanced meanwhile — leaves npm holding
`canopycms@0.0.64` while main still says `0.0.63`. Every subsequent publish run
re-bumps to `0.0.64` and dies on "cannot publish over previously published
version". The pipeline stays wedged until a human intervenes.

**Scenario.** PR A merges; its publish run finishes `npm publish canopycms`
(0.0.64) and is mid-way through `canopycms-next` when PR B's merge cancels it.
npm now has `canopycms@0.0.64` on `latest` but `canopycms-next@latest` is 0.0.63
— whose peer dependency is the **exact** pin `"canopycms": "0.0.63"` (verified in
published registry metadata), so a fresh `npm install canopycms canopycms-next`
hits ERESOLVE. B's publish run then fails at its first publish, as does every
later push to main.

**Fix direction.** `cancel-in-progress: false` for push events too (queueing is
already the prerelease posture), and make the bump resilient — derive the next
version from the registry (`npm view canopycms version`) rather than the
committed package.json, or commit the bump *before* publishing and publish from
the tag.

## 3. Every third-party action is pinned by mutable tag, including in the release workflow

`publish.yml:39,44,48,50` references `actions/create-github-app-token@v2`,
`actions/checkout@v4`, `pnpm/action-setup@v4`, `actions/setup-node@v4` by movable
tag; same pattern in `publish-prerelease.yml` and `ci.yml` (plus the
personal-account `dorny/paths-filter@v3` at `ci.yml:114`), and in the scaffold
`deploy-cms.yml.template:92,94,125` — where `aws-actions/configure-aws-credentials@v4`
sits in front of a CDK-admin OIDC role.

publish.yml is the maximum-blast-radius context: it mints a token from
`RELEASE_BOT_PRIVATE_KEY` whose app can bypass main's branch protection, and
holds `id-token: write` for npm trusted publishing with provenance across five
public packages.

**Scenario.** The `pnpm/action-setup@v4` tag is repointed after a maintainer
account compromise (the tj-actions/changed-files mechanism). The next push to
main runs attacker code inside publish.yml: it can publish a tampered `canopycms`
to `latest` with a **valid** provenance attestation, and push to main via the app
token. Both adopter sites auto-consume the package.

**Fix direction.** Pin third-party actions to full commit SHAs (tag in a
trailing comment) — at minimum in publish.yml, publish-prerelease.yml and the
generated deploy-cms.yml template. Dependabot/Renovate keeps the SHAs fresh.
`dorny/paths-filter` deserves the same or replacement with a git-diff step.

## Verified and NOT a defect: ci.yml's missing `permissions` block

Round 2 raised ci.yml having no `permissions:` block (its token scope being
whatever the repo default is, while `pnpm install` runs untrusted lifecycle
scripts with `actions/checkout`'s persisted credentials on disk). **Round 3
defused it**: the live repo's `default_workflow_permissions` is `read`, so the
exposure is not exploitable as configured.

Worth adding `permissions: { contents: read }` to ci.yml anyway as
defence-in-depth — every other workflow here, and the generated adopter
workflow, already scope theirs, and this one currently depends on a repo-level
setting that no one would think to check before changing. Recorded so a future
round does not re-report it as live.
