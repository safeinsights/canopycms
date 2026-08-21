# [P3] The prerelease main-guard checks a branch ref, so a tag dispatch slips past it

Found by the whole-branch independent review of `epic/infra-review-2026-08`
(2026-08-21), rated INFO. Filed rather than fixed because it is manual-only,
low impact, and outside that epic's findings.

## The defect

`publish-prerelease.yml`'s hard guard exists so the `int` channel can never
publish from `main` — main belongs exclusively to `publish.yml`'s stable
channel. It compares:

```bash
if [ "$GITHUB_REF" = "refs/heads/main" ]; then
```

A `workflow_dispatch` can select a **tag** as well as a branch. A tag pointing
at main's tip (every release tag does — `publish.yml` pushes `v<version>` right
after bumping) has `GITHUB_REF=refs/tags/v0.0.63`, which is not
`refs/heads/main`, so the guard passes and the run publishes an `int`
prerelease built from that tag's content.

## Why it is INFO and not higher

- **Manual only.** Nothing automatic dispatches this workflow.
- **`latest` is untouched.** The prerelease publishes under the `int` dist-tag,
  and npm semver excludes prereleases from ordinary range matching.
- **The version is still derived from main**, not from the dispatched ref, so
  it cannot collide with a stable version.

So the outcome is a redundant `int` build of content identical to a release,
not a wrong or dangerous publish. The guard's *stated intent* — "this workflow
must not be able to touch main even by accident" — is nonetheless not met.

## Fix direction

Compare the resolved commit rather than the ref name, or reject any
`refs/tags/` dispatch outright. Comparing `git rev-parse HEAD` against
`origin/main` also catches a branch that merely points at main's tip, which the
current check misses for the same reason. Note `publish.yml` gates the call as
well, so this is defence in depth on both sides.
