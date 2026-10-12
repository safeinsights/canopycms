---
priority: P3
adopters: NEITHER
summary: >-
  publish.yml's `publish` job runs `pnpm install` and the builds while holding `id-token: write`, so a compromised dependency's lifecycle script could request an OIDC token and publish as this repo's trusted publisher. Split it: build and pack in a job without id-token, upload the five tarballs, publish from a job that installs nothing
---
# Keep npm's id-token away from dependency code

Found by the Fable full-diff review of changesets PR B (2026-10-11). This existed before PR B:
the old single job also installed with `id-token: write`.

## The gap

`publish` (and `publish-prerelease.yml`'s job) runs `pnpm install --frozen-lockfile`, and with
it every dependency lifecycle script, while the job holds `id-token: write`. Such a script can
read `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, mint an OIDC token,
and publish any of the five packages as this repository's trusted publisher. PR B already keeps
the repository write token away from dependency code; the npm credential still meets it.

## Fix direction

1. **Build job, no id-token:** check out, install, build, run `migration-notes --ship`, pack all
   five, check the tarballs (CHANGELOG.md present, exact peer pins), then upload them as an
   artifact.
2. **Publish job:** holds `id-token: write`, downloads the artifact, installs nothing, and runs
   `pnpm dlx npm@11.19.0 publish <tgz>` per package, keeping the idempotency and dist-tag logic.
   Its checkout needs only `scripts/npm-attested-commit.mjs`, which is dependency-free.
3. **Prerelease:** do the same.

npm validates the calling workflow file (`publish.yml`), not the job, so both jobs can live in
`publish.yml`.
