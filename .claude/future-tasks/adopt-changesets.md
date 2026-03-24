# Adopt changesets for deliberate semver

## When

Once the canopycms API stabilizes (post-initial deployment with docs-site-proto).

## What

Replace the current auto-patch-on-main publishing workflow with [changesets](https://github.com/changesets/changesets) for deliberate semantic versioning.

## Why

Auto-patch (`0.0.x` bumps on every push to main) is fine for early development when we are the only consumer. Once there are multiple consumers or the API is meant to be stable, we need:

- Deliberate minor/major bumps to communicate breaking changes
- Release notes generated from changeset descriptions
- Ability to batch multiple PRs into a single release

## Steps

1. `npm install -D @changesets/cli && npx changeset init`
2. Configure `.changeset/config.json` with `"fixed"` array locking all 5 packages together
3. Replace `scripts/bump-version.mjs` + publish workflow with `changesets/action@v1`
4. Developers add changesets via `npx changeset` on each PR
