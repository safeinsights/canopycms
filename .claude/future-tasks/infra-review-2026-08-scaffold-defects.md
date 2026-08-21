# [P3] Five `canopycms init` / deploy-scaffold defects

From the 2026-08-20 three-round infrastructure review (rounds 1 and 2), all
**CONFIRMED** at HEAD `7881e489`. Grouped because they are one pass over
`cli/init.ts` and the template files. All are adopter-facing, on the exact path
the scaffold exists to smooth.

## 1. The cms-stack template's AssetSupport block does not compile

`template-files/cms-stack.ts.template:108-116` — the commented "uncomment to
enable media" block has three independent errors: `AssetSupport` is not in the
file's import from `canopycms-cdk`; `new AssetSupport(this, 'Assets', {})` omits
the **required** `editorOrigins` prop; and it directs the adopter to wire
`assetSupport.cloudFrontBehaviors`, a member that does not exist (the real API is
`assetBehaviors()`).

An adopter reaching the assets milestone follows the template's own instructions
and hits two type errors plus a nonexistent property, then has to
reverse-engineer the construct's actual API.

**Fix:** make the commented block real, compiling code, and consider a scaffold
test that type-checks the template with its comment markers stripped.

## 2. Generated deploy workflow's `paths:` filter omits files that must trigger a deploy

`template-files/deploy-cms.yml.template:62-74` filters to `app/**`, `src/**`,
`content/**`, `canopycms.config.ts`, `Dockerfile.cms`, `infrastructure/**`,
`cdk.json`, `package.json` and the lockfile. It omits:

- `next.config.ts` / `next.config.mjs` — the file `init-deploy aws` itself tells
  the adopter to edit for dual-build
- root `middleware.ts` — the Clerk middleware the scaffold generates for app-dir
  projects
- `public/**` — copied into the runner image, and needed for the preview-parity
  claim

An adopter edits `next.config.ts` and pushes: no deploy runs, and the change
ships days later piggybacked on an unrelated content edit, so any breakage is
attributed to the wrong commit. The workflow's own comment shows the authors
cared about exactly this failure class for dependency bumps.

**Fix:** add `next.config.*`, `middleware.ts` and `public/**` to the filter.

## 3. `init` writes middleware.ts to the project root regardless of `--app-dir`

`init.ts:180-184` writes `path.join(projectDir, 'middleware.ts')` with no `appDir`
involvement. Next.js only loads middleware from the parent of the `app`/`pages`
dir — verified in next@15.5.21 for both build (`build/index.js:540`:
`rootDir = path.join(pagesDir || appDir, '..')`) and dev
(`getPossibleMiddlewareFilenames(path.join(rootDir, '..'))`).

`init` explicitly supports multi-segment app dirs (`configImportPath` documents
`appDir="src/app"`), so for `--app-dir src/app` the generated file — including the
Clerk `auth.protect()` variant — is never loaded, with no warning from Next or
the scaffold. `/edit` and `/api/canopycms/*` get no edge protection:
unauthenticated visitors load the editor page shell and then see failed API calls
instead of being redirected to sign-in. The API's own Clerk enforcement still
holds, so this is a silent loss of an intended defence-in-depth layer plus broken
sign-in UX — not an authz bypass.

**Fix:** derive the location from `appDir` —
`path.join(projectDir, path.dirname(appDir), 'middleware.ts')`, normalized for the
plain `app` case.

## 4. `init` writes next.config.ts beside an existing .js/.mjs config

`init.ts:175-179` writes `next.config.ts` unconditionally, existence-checked only
against that exact filename. Next resolves exactly one config in the fixed order
`next.config.js`, `.mjs`, `.ts` (next@15.5.21 `shared/lib/constants.js:356-360`),
first match wins — so an adopter with an existing `.js`/`.mjs` config gets a new
file with no overwrite prompt and no warning, and Next silently keeps loading
theirs. `initDeployAws` already knows configs come as `.mjs` too (`init.ts:328-334`).

Everything `withCanopy` provides is then absent: the `/assets/:path*` rewrite
(media URLs 404), `transpilePackages`, and for `--dual-build` the `pageExtensions`
split and `output: 'export'` / `'standalone'` switching. `CANOPY_BUILD=static`
quietly produces a normal server build **with the editor included** — neither
static nor editor-free, and nothing in the build output names the cause.

**Fix:** mirror initDeployAws's probe — if a `.js`/`.mjs` config exists, don't
write a parallel `.ts`; print the manual `withCanopy` wiring as a `p.note`, or
offer to rename/merge.

## 5. `init` never creates a .gitignore when one is absent

`init.ts:187-194` appends the `.canopy-dev/` entry only `if (await filePathExists(gitignorePath))`.
The no-file branch does nothing, silently.

An adopter running `git init && canopycms init && next dev` then `git add .`
commits the entire `.canopy-dev` workspace — full git working trees with their
own `.git` directories. Git records each branch clone as a gitlink (the
embedded-repository warning is easily missed in a large add), producing broken
submodule-like entries with no `.gitmodules`; collaborators cloning get empty
directories where the CMS expects working trees. Recovery requires understanding
gitlinks, well beyond the non-technical audience the tool targets.

**Fix:** create `.gitignore` with the CanopyCMS block when absent, through the
same overwrite-safe helper, matching what the append path produces.
