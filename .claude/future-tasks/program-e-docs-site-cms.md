# Program E — Docs-site CMS deployment

**Part of:** [production-readiness-program.md](production-readiness-program.md)
**Size:** L · **Status:** not started · **Blocked by:** D green
**Repos:** `safeinsights/canopycms`, `safeinsights/docs-site-proto`

The deliverable that gets the teams editing content themselves.

## Starting state

`docs-site-proto` is already a Canopy adopter — `canopycms.config.ts`,
`src/app/schemas.ts` (6 entry schemas), `src/app/edit/page.server.tsx`,
`src/app/api/canopycms/[...canopycms]/route.server.ts`, `withCanopy()` in
`next.config.ts`, ~162 Canopy-managed content files. But it is pinned at
`canopycms@^0.0.54`, runs `mode: 'dev'` locally, and its `infrastructure/` deploys
a static-only site. `canopycms-cdk` is a declared dependency that is imported
nowhere.

## Non-negotiable: protect `dev-docs.sandbox.safeinsights.org`

The teams use it as a working docs site. Check every step against the protection
rules in [production-readiness-program.md](production-readiness-program.md). In
short: `dev-docs` changes only on a push to `testing-main`; Canopy content targets
a different distribution; every change is validated through a PR preview first;
the sync automation stays draft-PR-only until cutover; the
`updateDistributionOriginPath` fix lands before any asset origin exists; and the
rollback SHA is captured before starting.

## Aligning with APPROACH.md

`infrastructure/APPROACH.md` already designs for Canopy: content editors PR into
the content branch, developers work on the code branch, and branch *prefix*
selects deployment mode. In testing mode that means Canopy targets
**`testing-production`** → `docs.sandbox…`, while `testing-main` → `dev-docs…`
continues untouched.

Three APPROACH.md phases were specified but never built, and become part of this
workstream:

- **Phase 3 — the `production → main` sync PR workflow** with circular-sync
  detection (fully specified in `infrastructure/APPROACH-implementation-ideas.md`,
  lines ~61-190). Build it, but leave it **opening draft PRs for manual merge**
  until cutover — this is the one path by which Canopy-authored content could
  reach `dev-docs`.
- **Phase 4 — branch protection + CODEOWNERS.**
- **Phase 5 — Canopy `targetBranch` wiring** (`defaultBaseBranch` set to the
  content branch).

If D's inventory shows testing/production is serving something the teams rely on,
fall back to adding a fourth environment entry to
`infrastructure/cdk.json`'s `deploymentModes.testing.environments` (e.g.
`canopy-dev` → `canopy-docs.sandbox…`) — same account, new distribution, zero
impact on the three existing envs.

## Steps

1. **Upgrade Canopy `0.0.54` → current** on a branch off `testing-main`, consumed
   via the `int` prerelease channel from workstream A. Do this **before any infra
   work** so failures stay isolated, and validate it **through the PR preview**,
   never by merging to `testing-main` to see what happens. Expect schema,
   API-client, and build-shape churn across ~13 versions.
2. **Structured image field migration** — see
   [adopter-image-field-migration.md](adopter-image-field-migration.md). Images are
   currently plain string paths (`logo: /images/logos/quill.png`, markdown
   `![...](/figures/...)`) with `images: { unoptimized: true }` and ~11MB under
   `public/`. Schema + content codemod to the structured `image` field. The
   serving-neutral part lands immediately; optimizing the 1.5–3.3MB offenders
   waits on the asset bucket.
3. **Land the `updateDistributionOriginPath` fix** in
   `infrastructure/scripts/lib/aws.ts` — it currently loops over
   `config.Origins.Items` and stamps `builds/{sha}` onto *every* origin. Must be
   fixed to match by origin Id **before** any asset origin exists anywhere.
4. **New CMS stack** in the sandbox account alongside the static stacks:
   `CanopyCmsService` + CloudFront, distinct `deploymentName` (needs B1), its own
   EFS, its own Clerk instance, its own bot credentials. This is the first use of
   `canopycms-cdk` by a real adopter.
5. **Wire assets** — see
   [docs-site-assets-wiring.md](docs-site-assets-wiring.md). `AssetSupport` in
   BYO-bucket mode onto `infrastructure/lib/artifacts-stack.ts`, with `/assets/*`
   and `/assets/t/*` behaviors added to the Canopy-targeted distribution first.
   Note the OAC-on-imported-bucket caveat: CDK cannot add the OAC grant to an
   imported `IBucket`'s policy, so that goes on by hand.
6. **Bot identity** — replace the deploy-test's fine-grained PAT with a dedicated
   machine account. GraphQL draft-conversion (withdraw / request-changes) was
   never exercised and is the known fine-grained-PAT risk.
7. **Real editors** — invite a few people from the teams; run on real content
   against `docs.sandbox…`.
8. **Cutover** on a planned date: enable the sync automation, point the teams at
   the Canopy-backed flow, rollback rehearsed beforehand.

## Verification

- D's verification suite passes against the docs-site CMS deployment.
- A real editor completes edit → submit → merge → published.
- **`dev-docs.sandbox…` is proven unchanged throughout** — compare the
  distribution's origin path and the served content before and after.

## Definition of done

Team members edit docs-site content through a deployed editor, changes flow to a
published site, and the site the teams read only changes when we decide it does.
