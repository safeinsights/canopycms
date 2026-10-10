# Adopter Migration Guide

What changed in CanopyCMS, what you must do to adopt it, and **what you can now delete**.

## How to use this document

Each entry has up to three parts:

- **What changed**: the package-side change.
- **To adopt**: what you do in your repo.
- **Now deletable**: the kind of local code the change supersedes. **This part is the point.**
  Adding the new API without removing what it replaces leaves two implementations to drift apart.

**Find your starting point.** From a stable pin, start at the first version under **Released**
newer than it, and below `0.0.63` read the notes for `0.0.62 and earlier` too. From an int
prerelease such as `0.0.68-int.101`, read only the **Unreleased** entries, or labelled parts of
entries, carrying a higher int number (the table lists later parts in parentheses).

**Find your target.** `npm view canopycms version` reports the `latest` dist-tag, the newest
stable release; `main` publishes a patch on every push, so never take a target from this document.
On the int channel that command answers the wrong question: a prerelease comes from an integration
branch, so read this file at the ref your build came from (`packages/canopycms/README.md`, inside
your installed package, shows how to resolve it from the npm provenance attestation).

**Read every window between the two, oldest first.** Deletable-code lists compound. Where a later
entry replaces an earlier one's advice, the earlier one points to it.

---

## Unreleased

**Promoting entries is manual.** When a release ships, move its entries under a new `### <version>`
in `## Released`, demoting `###` to `####` and keeping their int labels. `pnpm lint:docs` fails
when a release tag reachable from `HEAD` has no `### <version>` section; which entries belong to it
is still a read of `git log`.

**int** is the first int prerelease carrying an entry, and each part of the entry is labelled
`(int.N)` the same way; a number in parentheses after a change is a later int that added a part.
**Action** says who must act; **Template first** means that with `workerCode: { source: 'parameter' }`,
you deploy the stack template before CI rolls that int's bundle. `next` marks a change no published int carries yet; publishing an int
replaces each `next` with its number.

| int  | Area     | Change                                                                                                                                                                                      | Action                       |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 93   | Branches | [Path rules match logical paths](#path-permission-rules-now-take-effect-below-the-content-root--security-fix-breaking-for-rules-written-with-on-disk-names)                                 | Review rules                 |
| 93   | Branches | [`.canopy-meta/` must not be committed](#canopy-meta-must-not-be-committed-and-system-health-says-so)                                                                                       | If tracked                   |
| 93   | Branches | [`autoCreateSettingsPR` removed](#settings-saves-only-push-the-settings-branch--breaking-config-autocreatesettingspr-is-removed)                                                            | Required                     |
| 93   | Reading  | [Listings take `branch`; reads report `slug`/`urlPath`](#content-reads-listings-take-a-branch-and-reads-report-slug-and-urlpath) (102)                                                      | Index pages                  |
| 93   | Editing  | [Field descriptions, list-card titles, `public/` images](#field-editing-descriptions-list-card-titles-and-public-images) (96, 103)                                                          | None                         |
| 93   | Branches | [Commits name editors; submit refuses an empty branch](#commits-name-their-editors-and-submit-refuses-a-branch-with-nothing-to-submit) (108, 110)                                           | Scripts                      |
| 94   | Branches | [Reads never create a branch](#reads-never-create-a-requested-branch--security-fix-breaking-for-some-direct-createcontentreader-callers)                                                    | Direct callers               |
| 94   | Preview  | [Preview URLs: one prefix, `trailingSlash`, own page](#preview-urls-take-one-prefix-follow-trailingslash-and-load-each-entrys-own-page--breaking-env) (98)                                  | Required                     |
| 94   | Preview  | [`createPreviewPage`, `/preview` entries](#the-preview-route-and-preview-entries--breaking-imports) (95, 101, 103)                                                                          | Required                     |
| 94   | Refs     | [Restricted and missing references](#a-reference-resolves-to-its-target-a-restricted-stub-or-a-missing-stub--security-fix-breaking-types-and-build) (106)                                   | Required                     |
| 94   | CDK      | [`attachTo`, editor response headers](#canopycms-cdk-canopycmsserviceattachto-and-editor-response-headers--behaviour-change-if-you-frame-the-cms)                                           | If hand-wired or framed      |
| 94   | Ops      | [System health shows the build](#system-health-shows-which-build-is-running)                                                                                                                | Optional                     |
| 100  | Branches | [Crash-safe branch creation](#fast-crash-safe-branch-creation--behaviour-change-branch-clones-hold-only-the-content-root)                                                                   | Upgrade together             |
| 100  | Ops      | [Prod workspace defaults to `/mnt/efs`](#the-prod-workspace-defaults-to-mntefs--behaviour-change-if-you-run-prod-without-canopycms_workspace_root)                                          | Non-CDK prod                 |
| 100  | Assets   | [`AssetSupport` serves from S3 only](#canopycms-cdk-assetsupport-serves-images-from-s3-only--breaking)                                                                                      | Required                     |
| 100  | Assets   | [`collect-asset-refs`, `materialize-assets`](#collect-asset-refs-and-materialize-assets-store-a-builds-images-before-release) (104)                                                         | With S3-only                 |
| 100  | Assets   | [Editor images via signed-in route](#the-editor-and-its-live-preview-load-images-through-the-signed-in-asset-route)                                                                         | CSP, origin                  |
| 100  | Assets   | [`assetUrl` applies crop](#asseturl-applies-an-image-values-crop--behaviour-change-for-cropped-images)                                                                                      | Scale `<img>`                |
| 100  | Assets   | [`media.publicBaseUrl` removed; wider limits](#mediapublicbaseurl-is-removed-and-image-limits-are-wider--breaking-config)                                                                   | Delete key                   |
| 101  | Editing  | [Saves rewrite only what changed](#a-save-rewrites-only-what-changed) (103)                                                                                                                 | None                         |
| 102  | Auth     | [`unauthenticatedStatus: 419`](#unauthenticatedstatus-answer-signed-out-api-calls-with-419)                                                                                                 | Basic-auth sites             |
| 105  | Editing  | [MDXEditor 4.3](#the-markdown-editor-runs-mdxeditor-43)                                                                                                                                     | Direct deps                  |
| 106  | Refs     | [AI content links references](#ai-content-links-a-reference-to-its-target--behaviour-change-for-ai-output-and-ai-config-callbacks)                                                          | AI config                    |
| 106  | Refs     | [Deleting a referenced entry asks](#deleting-a-referenced-entry-asks-first--behaviour-change-on-the-delete-api)                                                                             | Scripts                      |
| 107  | Schema   | [Unknown schemas cost one entry type](#a-schema-the-running-code-lacks-costs-one-entry-type-and-holds-the-worker--behaviour-change)                                                         | Rare                         |
| 108  | MDX      | [MDX that runs code is refused](#mdx-content-that-runs-code-is-refused-at-save--breaking-behaviour) (109, 110)                                                                              | Required                     |
| 108  | Worker   | [On-demand worker, drain; `spotMaxPrice` removed](#canopycms-cdk-the-worker-drains-before-replacement-and-runs-on-demand--breaking-props-spotmaxprice-is-removed-behaviour-and-cost-change) | If set                       |
| 109  | Worker   | [Hardened worker instance](#canopycms-cdk-the-worker-instance-is-hardened--an-existing-stack-upgrades-in-two-deploys-behaviour-and-cost-change)                                             | Two deploys                  |
| 109  | Worker   | [Failed or stopped worker says why](#a-failed-or-stopped-worker-says-why--behaviour-change-on-the-not-ready-503-new-worker-apis)                                                            | Custom entrypoint            |
| 109  | Worker   | [CI worker roll; worker-down alarm](#canopycms-cdk-ci-can-roll-the-worker-with-a-parameter-and-alarm-when-it-stops-syncing--new-opt-in)                                                     | Optional                     |
| 109  | Preview  | [Typed `fieldProps`](#preview-fieldprops-is-typed-with-server-safe-helpers--breaking-types-and-schemas)                                                                                     | Required                     |
| 110  | Worker   | [Worker needs a state directory](#canopycms-cdk-the-worker-needs-a-state-directory--deploy-the-template-before-the-bundle)                                                                  | Template first               |
| 110  | Ops      | [Prod detects an unset `defaultBaseBranch`](#prod-detects-an-unset-defaultbasebranch-instead-of-assuming-main--behaviour-change-startup-can-fail)                                           | Base ≠ repo default          |
| 111  | CDK      | [Example workflow's triggers and checks](#the-aws-example-workflow-gains-the-templates-triggers-and-dependency-checks)                                                                      | If copied by hand            |
| 111  | Ops      | [Duplicate-ID scan only on request](#get-adminbranch-health-scans-for-duplicate-content-ids-only-on-request--behaviour-change)                                                              | Admin-API scripts            |
| 111  | Auth     | [CMS image builds a prod editor; mismatch blocks](#the-cms-image-builds-a-prod-editor-and-a-mode-mismatch-blocks-the-editor--behaviour-change-a-hand-built-image-can-fail-its-build)        | Hand-built images            |
| 111  | Auth     | [Auth plugins look users up in batches](#auth-plugins-look-users-up-in-batches)                                                                                                             | Custom plugins               |
| next | Worker   | [Bundle states the template it needs](#canopycms-cdk-a-worker-bundle-states-the-template-it-needs--template-first-for-the-gate-only)                                                        | Template first               |
| next | Worker   | [Poisoned `remote.git` re-clones](#a-poisoned-remotegit-re-clones-itself)                                                                                                                   | None                         |
| next | Worker   | [Nano worker boots reliably](#canopycms-cdk-a-t4gnano-worker-boots-reliably--behaviour-change-a-deploy-replaces-the-worker)                                                                 | Deploy                       |
| next | Worker   | [Worker log is root-owned](#canopycms-cdk-the-workers-log-is-root-owned--security-fix)                                                                                                      | Deploy; hand-installed units |

### Preview URLs take one prefix, follow `trailingSlash`, and load each entry's own page — **breaking (env)**

**What changed.**

- (int.94) `editor.previewPrefix` (a path or `https://` URL) goes in front of every preview URL,
  site-relative `previewBase` routes included. Preview URLs follow `trailingSlash`, and the preview
  bridge matches a page with or without one. `CANOPY_API_TRAILING_SLASH` is renamed
  `CANOPY_TRAILING_SLASH`.
- (int.98) The preview pane loads each entry's `urlPath`: `content/about` previews `/about`, not
  `/`. A `previewBase` value of `false` marks an entry with no page, and the pane says so.

**To adopt.** Set `editor: { previewPrefix: '/preview' }` once that route exists (next entry), and
drop the prefix from any `previewBase` value that spells it. Rename a `CANOPY_API_TRAILING_SLASH`
you set yourself. Key an entry without a page `false` (`'content/settings': false`). A root entry
served at `/` without an `index` slug needs `'content/<slug>': '/'`, or re-model it as a root index
([0.0.64](#sitemap-pathfor-and-modelling-a-page-served-at--as-a-root-index-entry)).

**Now deletable.** `previewBase` keys that only added a shared prefix or restate a root entry's own
URL.

### The preview route and `/preview` entries — **breaking (imports)**

**What changed.**

- (int.94) The context's `createPreviewPage({ views })` serves a `[[...path]]` route at
  `editor.previewPrefix`, rendering `?branch=` through `views[entryType]`, so a static-export site
  can preview a branch.
- (int.95) `previewView({ view, load })` feeds a view server-read `extras`.
- (int.101) `withCanopyPreview` and `CanopyPreviewViewProps` come from `canopycms-next/preview`, and
  preview hooks like `useCanopyPreview` from `canopycms/preview`. The `/client` entries are the
  editor: they put Mantine's unlayered CSS over the site's styles in the preview, and ship the
  editor to public pages.
- (int.103) On that route a `withCanopyPreview` view is not server-rendered. It renders right after
  hydration with its `/assets/t/` URLs behind the signed-in asset route, so a crop no build made
  never returns 403; server components from `load` get the same prefix. Until hydration the view's
  area is empty, so content below it can shift. A view that throws fails in the browser, and its
  effects run after the preview's ready message. Pages calling `useCanopyPreview` themselves are
  unchanged.

**To adopt.**

1. Import preview APIs, and point their test mocks, at the `/preview` entries. A
   `vi.mock('canopycms-next/client', …)` silently stops applying.
2. For a branch preview: wrap views with `withCanopyPreview` in a `'use client'` module, add
   `app/preview/[[...path]]/page.server.tsx`, set `editor.previewPrefix: '/preview'`, and serve that
   route with `frame-ancestors 'self'`, not `X-Frame-Options: DENY` (see
   [Live Preview](../README.md#live-preview)).
3. A test reading view content from the route's server HTML must load the page in a browser.
   Server output rendered during a preview request carries the signed-in asset prefix; keep it out
   of cross-request caches (`unstable_cache`, module memos).

**Now deletable.** A hand-built branch-preview route, and CSS layer or specificity workarounds that
kept site styles ahead of Mantine's in the preview.

### Preview `fieldProps` is typed, with server-safe helpers — **breaking (types and schemas)**

**What changed.** (int.109) `fieldProps` checks each path against the view's content type, and
`canopycms` exports `FieldProps`, `FieldAttrs`, `fieldAttrs` and `scopeFieldProps`, callable from
server components. A string path marks the form's spelling (`'a.0.b'` marks `a[0].b`), and an empty
path marks nothing. The editor counts and logs marks naming no field. `createEntrySchemaRegistry`
refuses a field name that is empty, all digits or contains `.`, `[` or `]`. See
[Live Preview](../README.md#live-preview).

**To adopt.** Fix each path that stops compiling; the error lists valid ones. Rewrite computed paths
as literal segments, or type that component's prop as plain `FieldProps`. Pass `fieldProps` as
`undefined` on public pages. Rename refused fields and their content keys.

**Now deletable.** A local `FieldProps` type, `fieldAttrs`/`scopeFieldProps` helpers and no-op
`fieldProps` defaults; schema-walking tests for misspelled mark paths, once components are typed
(the editor flags another block template's field).

### A reference resolves to its target, a restricted stub, or a missing stub — **security fix; breaking (types and build)**

**What changed.**

- (int.94) A target the reader may not read resolves to
  `{ id, slug, collection, urlPath, title, unavailable: true, reason: 'restricted' }`
  (`RestrictedReference`), never its data. Static builds are unchanged. A schema may not declare a
  top-level field named `unavailable`.
- (int.106) An id naming no entry resolves to `{ id, unavailable: true, reason: 'missing' }`
  (`MissingReference`), not `null`, and a production build fails on one, naming entry, field path
  and id. Saving the referring entry keeps the id; a save adding a new dangling id is refused.
- (int.106) The live preview resolves references inside objects, object lists and blocks too. One
  still resolving is `null`, even in an entry's first draft. `isLoading` mirrors the data at depth,
  typed `PreviewLoadingState<T>`, so a reference's entry is `boolean | undefined`.

A `resolvedSchema` reference infers as `Target | UnavailableReference | null` (`RestrictedReference`
before int.106).

**To adopt.** Narrow on `unavailable`, then on `reason`; only a restricted reference has a title
and URL:

```tsx
if (!ref) return null
if (ref.unavailable) {
  return ref.reason === 'restricted' ? <a href={ref.urlPath}>{ref.title}</a> : null // 'missing'
}
```

`isResolvedReference(ref)` (from `canopycms`) is true only for the target itself. Test
`reason === 'missing'` where you tested `null`, and write `Exclude<…, UnavailableReference>` where
you wrote `Exclude<…, RestrictedReference>`. Rename any `unavailable` field. Repoint or clear each
reference the build lists, or set `danglingReferences: 'warn'`. Make a prop fed from `isLoading`
optional if it was required.

**Now deletable.** Hand-written reference narrowing (string id, `null`, `unavailable` checks), a
content-integrity test checking reference fields against entry ids, and top-level-only reference
fields kept for the preview's sake.

### AI content links a reference to its target — **behaviour change for `/ai` output and AI config callbacks**

**What changed.** (int.106) A `reference` field renders as a link to its target, not the stored id:
a byline reading `**Author:** 5NVkkrB1MJUv` now links the name `Alice` to that entry's page, then to
its markdown copy under the AI config's new `mountPath` (default `/ai`). A gone target renders as
`(missing entry <id>)`, one left out by `exclude` as `(unavailable entry <id>)`. An md/mdx entry's
object or block field renders as a section, not `[object Object]`.

`where` predicates and transforms receive an `AIReferenceValue` (from `canopycms/ai`), not the id:

```ts
// before
where: (entry) => entry.data.author === ALICE_ID
// after
where: (entry) => (entry.data.author as AIReferenceValue | undefined)?.id === ALICE_ID
```

**To adopt.** `entry.data` is untyped, so an old comparison still compiles and silently stops
matching: search your AI config for each reference field's name.

**Now deletable.** A `fieldTransforms` entry that looked up a reference id to print its title.

### Deleting a referenced entry asks first — **behaviour change on the delete API**

**What changed.** (int.106) Deleting an entry that other entries reference (by field or `entry:`
link) returns 409 with `data.referencedBy`: the referencing entries the user may read, and a
`hiddenCount` of the rest. `?confirmReferenced=true` deletes anyway; the editor's dialog offers
**Delete anyway**.

**To adopt.** Only scripts calling the delete endpoint: pass the flag or handle the 409.

### `mdx` content that runs code is refused at save — **breaking (behaviour)**

**What changed.** (int.108) An `mdx` field or body refuses `{…}` expressions other than comments and
plain values, `import`/`export`, and tags, attributes and URL schemes outside a safe set; other
markdown refuses those URLs. New: field option `executable`; type `MarkdownFieldConfig`. (int.109)
A `markdown` field with `renderAs: 'mdx'` is checked as MDX, and `mdxAllow` narrows the safe set per
field or site-wide. New: field options `renderAs`, `mdxAllow`; config key `mdxAllow`; type
`MdxAllowlist`. (int.110) A component prop allowance can be `'string'` (or
`{ type: 'string', maxLength }`): a quoted value only, never bare or `{…}`. See
[MDX content cannot run code](../README.md#mdx-content-cannot-run-code).

**To adopt.** Set `renderAs: 'mdx'` on each `markdown` field your site compiles as MDX, and
`mdxAllow` to what your renderer takes. Set `executable: true` only on a field whose editors you
trust as code authors; an entry type with no `isBody` field needs one declared to opt its body out.
Content already there is kept, with a warning, while its field is saved unchanged; a production
build lists it.

**Now deletable.** A `validateEntry` rule refusing expressions, ESM, tags, components or
`javascript:` links in MDX or markdown rendered as MDX, and the path-prefix matching behind its
entry-type gate. Keep a rule checking that the body compiles.

### A save rewrites only what changed

**What changed.**

- (int.101) In YAML and JSON entries and md/mdx frontmatter, untouched values, comments, blank
  lines and (in `.yaml` and `.json` files) CRLF line endings stay as written, and an edited `>-`,
  `|` or quoted value keeps that style where it can. Anchors, aliases and rare layouts still
  re-serialise the whole file. This extends [0.0.64's comment
  preservation](#editor-saves-keep-comments-and-report-content-keys-the-schema-does-not-define-29).
- (int.103) An md/mdx body save keeps every untouched block verbatim (markers, escapes, JSX, blank
  lines, CRLF), so `prettier --check` passes. New and edited blocks use Prettier's markers (`-`,
  `_emphasis_`, `---`); a new entry's body starts after a blank line. A hard break or a bare URL
  before punctuation still changes on the first edit. A body with text after a nested list in a
  list item opens as source.

**To adopt.** Nothing.

**Now deletable.** A formatter pass or `.prettierignore` entry over CMS-written content that only
undoes the editor's re-folding, restyling or date rewriting.

### The markdown editor runs MDXEditor 4.3

**What changed.** (int.105) `@mdxeditor/editor` is `^4.3.2` (Lexical 0.48), up from `^3.52.4`.
Two-paragraph list items, multi-block quotes and code fences in any language edit in rich text.

**To adopt.** Nothing, unless your app depends on `@mdxeditor/editor` or `lexical` directly: align
those versions so one copy loads.

### Field editing: descriptions, list-card titles, and `public/` images

**What changed.**

- (int.93) An `object` field with `list: true` takes `itemTitleField`, naming a direct `string` or
  `number` child whose value titles each card (else `<label> #N`). Cards no longer repeat the label
  as an inner legend.
- (int.96) A field's `description` renders under its label for every type; a list field shows it
  once, never per item. A block template's `description` still does not render.
- (int.103) An `image` field whose `src` is outside `/assets/`, such as `/logos/x.svg`, previews at
  that src and has no Crop button: a crop never applies outside the asset store.

**To adopt.** Nothing. Read your existing descriptions, which editors now see. To crop a `public/`
image, upload a raster copy to the media library. For card titles:
`{ type: 'object', list: true, itemTitleField: 'label', fields: [...] }`.

**Now deletable.** Editor hints worked into a field's `label` because `description` never showed.

### Content reads: listings take a `branch`, and reads report `slug` and `urlPath`

**What changed.**

- (int.93) `listEntries()`/`buildContentTree()` accept `branch`, like `read()`.
- (int.102) `read()`/`readByUrlPath()` return `meta.slug` and `meta.urlPath`, and a preview `load`
  gets `entry.slug` and `entry.urlPath`, each computed as `listEntries` computes them.

**To adopt.** Index pages pass `searchParams`' `branch` through, so editor previews list that
branch.

**Now deletable.** Code parsing a slug or URL back out of `path` or `entry.path`.

### Path-permission rules now take effect below the content root — **security fix; breaking for rules written with on-disk names**

**What changed.** (int.93) Rules match an entry's logical path (`content/blog/my-post`). Enforcement
checked the id-suffixed on-disk path, so collection and entry rules matched nothing; only a glob
that also matched on-disk names, such as `content/**`, worked. Renaming also requires edit access
at the new path.

**To adopt.** Review your rules (Settings → Manage Permissions) before upgrading: collection rules
that never took effect will start to. Rewrite any rule naming an id-suffixed directory or a file
extension in logical form (`content/blog/**`, `content/about`).

**Now deletable.** A content-root grant working around inert collection grants.

### Reads never create a requested branch — **security fix; breaking for some direct `createContentReader` callers**

**What changed.** (int.94) A branch other than the active one must exist and be readable by the
user, or `read()`/`readByUrlPath()` treat it as not found; no workspace is created per `?branch=`
value. `createContentReader` defaults `allowCreateBranch` to `false`.

**To adopt.** Nothing via `getCanopy()`. A script creating a branch through `createContentReader`
passes `allowCreateBranch: true`, never with a request's branch.

**Now deletable.** Checks that allow-list `?branch=` before it reaches `read()`.

### Fast, crash-safe branch creation — **behaviour change: branch clones hold only the content root**

**What changed.** (int.100) A branch is built under a staging name and appears only when complete.
The worker repairs branch directories an interrupted create or delete left wedged, and owns
`remote.git`'s gc config and repacking. A content branch's clone checks out only the content root,
`.canopy-meta` and root-level files, so request-time reads elsewhere in it find nothing. The editor
recovers a create that timed out instead of reporting an HTTP 504.

**To adopt.** Upgrade `canopycms` and `canopycms-cdk` together; no config, no deploy order. A
changed `contentRoot` reaches existing clones within a worker cycle of the API restarting.

**Now deletable.** Manual EFS cleanup of provisioning locks or half-made branch directories, and
`remote.git` gc scripts.

### `.canopy-meta/` must not be committed, and System health says so

**What changed.** (int.93) The schema cache lives in each branch clone's `.git/canopycms/`. Sync,
editor submits and `canopycms sync` ignore `.canopy-meta/`, and System health shows the base
branch's refresh outcome and warns when your repo tracks `.canopy-meta/`.

**To adopt.** If `git ls-files .canopy-meta` lists anything, run `git rm -r --cached .canopy-meta`,
add `.canopy-meta/` to `.gitignore`, and commit. The base branch's workspace follows by itself; an
editing branch whose copy of that state changed shows a rebase failure until its workspace is
repaired or re-created.

**Now deletable.** Any local step that resets or reformats `.canopy-meta/` files before a commit or
a format check.

### Commits name their editors, and submit refuses a branch with nothing to submit

**What changed.**

- (int.93) Submit commits gain an `Edited-by: Name (id)` trailer; PR bodies gain a section that
  re-submits replace, keeping human text. Options: `gitEditedByTrailers`, `gitCoAuthoredByTrailers`
  ([reference](../README.md#definecanopyconfig-options)).
- (int.110) Submit-commit trailers name every user who saved since the last submit commit, and
  the PR-body section every user who edited the branch, not only the submitter; settings commits
  (permissions, groups) carry the acting user's trailer.
- (int.108) Submit answers 400 when a branch's saved content matches its base. `BranchMetadata`
  gains optional `submittedAt` and `pushedToGitHubAt`.

**To adopt.** Scripts calling submit: save a change first, or handle the 400.

### Settings saves only push the settings branch — **breaking (config): `autoCreateSettingsPR` is removed**

**What changed.** (int.93) The orphan settings branch can never get a PR, so groups and permissions
saves only push the branch, and no failing PR task lands in System health.

**To adopt.** Delete `autoCreateSettingsPR` from `canopycms.config.ts`.

**Now deletable.** Filters that hid the failed settings-PR tasks.

### A schema the running code lacks costs one entry type, and holds the worker — **behaviour change**

**What changed.** (int.107) When synced content names an entry schema the running code lacks, only
that entry type goes unavailable: the editor says so, and its entries answer 503 with
`code: 'SCHEMA_UNAVAILABLE'`. Builds, static deploys and `generate-ai-content` still fail. The
worker holds the base branch for up to 30 minutes while that lasts; see
[New schemas wait for the editor deploy](deploying-to-aws.md#new-schemas-wait-for-the-editor-deploy).
Public types gain optional `unavailable` on `EntryTypeConfig` and `FlatSchemaItem`, optional
`ApiResponse.code`, and a required `SchemaResolutionResult.issues`.

**To adopt.** Code that builds a `SchemaResolutionResult` adds `issues`. A custom worker entrypoint
can pass `schemaHoldMaxMs` to `CmsWorker`.

### `canopycms-cdk`: the worker drains before replacement and runs on-demand — **breaking (props): `spotMaxPrice` is removed; behaviour and cost change**

**What changed.** (int.108) The worker is one on-demand `t4g.nano` by default (about $3 a month,
against spot's $1–2); a spot shortage could leave no worker: on a first deploy the editor's API answers 503 "CMS worker not
ready", and later publishes wait. Spot is
opt-in: `workerCapacity: { type: 'spot' }`, a mixed-instances policy that still cannot guarantee a
worker. A terminating lifecycle hook (`canopycms-worker-drain`, heartbeat
`workerTerminationHeartbeat`, default 5 minutes) lets the old worker finish in-flight work for up
to 90 seconds and requeue the rest with no retry spent. The systemd unit gains `KillMode=mixed`,
`TimeoutStopSec=120` and exit status 75 handling; the worker role may complete its own group's hook.

**To adopt.** Replace `spotMaxPrice: '…'` with `workerCapacity: { type: 'spot', maxPrice: '…' }`,
or drop it. A hand-installed unit copies the new lines from `worker/canopy-worker.service`. The
drain applies from the deploy after this one.

**Now deletable.** Any override stripping `InstanceMarketOptions` from the worker's launch template.

### `canopycms-cdk`: the worker instance is hardened — **an existing stack upgrades in two deploys; behaviour and cost change**

**Upgrade an existing stack in two deploys:**

1. Deploy with `efsEnforceIamAndTls: false` on `CanopyCmsService`. The worker is replaced by one
   that mounts EFS with IAM, and no file-system policy exists yet.
2. Remove the prop and deploy again. The policy lands while every client already uses IAM and TLS.

In a single deploy, CloudFormation updates the file system's policy before it replaces the worker.
The outgoing worker still holds an anonymous mount then, and if its connection drops, its NFS calls
hang until the drain heartbeat lets termination continue. Its in-flight task is retried later. A
new stack needs no steps.

**What changed.** (int.109) Detailed in
[The worker instance](deploying-to-aws.md#the-worker-instance): IMDSv2 with a hop limit of 1; the
bundle is one file whose sha256 user data checks, readable as that one object; a file-system policy
refusing clients without TLS or IAM, replacing the worker's
`AmazonElasticFileSystemClientReadWriteAccess`; an encrypted gp3 root volume; a boot-time upgrade to
the latest AL2023 release; a weekly replacement (`workerMaxInstanceLifetime`); a sandboxed systemd
unit; and daily EFS backups (`efsBackup`, billed per GB-month).

**To adopt.** The two deploys above. Anything else that mounts this file system needs `tls,iam` and
`elasticfilesystem:ClientMount`. A hand-installed unit copies the sandbox lines from
`worker/canopy-worker.service`. If your account encrypts EBS by default with a customer-managed
key, grant the Auto Scaling service-linked role on it. Pass `workerMaxInstanceLifetime: null` or
`efsBackup: false` to opt out.

**Now deletable.** Any override adding `MetadataOptions`, an encrypted root volume or an EFS
`FileSystemPolicy`, or narrowing the worker role's asset-bucket grant.

### `canopycms-cdk`: the worker needs a state directory — **deploy the template before the bundle**

**What changed.** (int.110) The worker's git keeps the GitHub credential in a private mirror
under the unit's `StateDirectory=`, and the worker does not start without it.

**To adopt.** Default `workerCode`: nothing. `workerCode: { source: 'parameter' }`: `cdk deploy` the
new template before CI rolls an int.110 or later bundle; a parameter-only change set never applies
the new unit, so the new bundle exits at start. A hand-installed unit needs
`StateDirectory=canopy-worker` under `[Service]`.

### A poisoned `remote.git` re-clones itself

**What changed.** A `remote.git` missing its base branch is re-cloned unless an unpushed ref would be
lost; the refusal names those refs. A tampered config still refuses and needs an operator.

**To adopt.** Nothing.

### A failed or stopped worker says why — **behaviour change on the not-ready 503; new worker APIs**

**What changed.** (int.109) While the latest start's recorded failure stands, the prod not-ready 503
is `WORKER_FAILED`: no `Retry-After`, the failure named to admins, account ids masked.
`CmsWorker.selfStopped` settles when the worker stops itself (a lost EFS lock); the `canopycms-cdk`
entrypoint then exits 69. `recordWorkerStartupFailure` records a failure before `start()`.

**To adopt.** A hand-written entrypoint calls `recordWorkerStartupFailure` on a pre-`start()`
failure and exits non-zero on `selfStopped`, with a code outside `RestartPreventExitStatus=`.

**Now deletable.** A watchdog that restarts an idle worker process.

### `canopycms-cdk`: CI can roll the worker with a parameter, and alarm when it stops syncing — **new, opt-in**

**What changed.** (int.109)

- `workerCode: { source: 'parameter' }` on `CanopyCmsService` selects the worker bundle by a
  sha256 template parameter (its logical id is the `WorkerBundleSha256ParameterName` stack output), from a bucket the construct creates. The package ships the bundle
  with its hash, as `worker/dist/index.js` and `index.js.sha256`. The default, `'asset'`, is
  unchanged.
- `CanopyCmsService` alarms when the worker logs no git sync for 30 minutes. See
  [Worker-down alarm](deploying-to-aws.md#worker-down-alarm).

**To adopt.** Optional. For parameter-only change sets, see
[Rolling the worker from CI](deploying-to-aws.md#rolling-the-worker-from-ci). For the alarm, pass
`alarmTopic`.

**Now deletable.** A manual `cdk deploy` after each canopycms bump whose only purpose is moving the
worker, and a hand-built alarm on the worker log group.

### `canopycms-cdk`: a `t4g.nano` worker boots reliably — **behaviour change: a deploy replaces the worker**

**What changed.** (next int) The boot's `dnf upgrade` could be OOM-killed on every retry. A 1 GiB
swap file now goes on first; an upgrade that still fails starts the worker unpatched and notifies
`alarmTopic` if set; a retried step names itself when it gives up. See
[The worker instance](deploying-to-aws.md#the-worker-instance).

**To adopt.** Deploy, which replaces the worker instance. The bundle needs none of this, so it is
not Template first and the worker contract stays at 1.

**Now deletable.** An instance type above `t4g.nano` chosen only to get the boot through.

### `canopycms-cdk`: the worker's log is root-owned — **security fix**

**What changed.** (next int) `/var/log/canopy-worker` and `worker.log` are root-owned, and the unit
drops `LogsDirectory=`. systemd opens the log as root, following symlinks, before the sandbox
applies, so a worker owning the directory could swap `worker.log` for a symlink and have its
output appended to any file on the instance. The log stays readable without `sudo`.

**To adopt.** Deploy, which replaces the worker instance. It is not Template first, and the worker
contract is unchanged. A hand-installed unit needs the same change:

1. Delete its `LogsDirectory=` line, which chowns the directory on every start.
2. `systemctl daemon-reload`.
3. `chown root:root` the directory and `worker.log*`.
4. `chmod 0755` the directory.
5. Restart.

**Now deletable.** Nothing.

### `canopycms-cdk`: a worker bundle states the template it needs — **template first for the gate only**

**What changed.** (next int) The worker unit carries a contract version
(`Environment=CANOPYCMS_WORKER_CONTRACT=<n>`). Parameter mode outputs it as `WorkerContract`, and
the package ships the bundle's need as `worker/dist/index.js.contract`. A bundle refuses to start
under an older unit, logging `template too old for this bundle`; an unstamped unit with
`StateDirectory=` (int.110 and later) counts as contract 1, so it runs this bundle. A new bundle
changes the template too (the fallback bundle's key and hash), so only the contract says whether a
bundle-only roll is safe.

**To adopt.** Parameter mode: gate bundle-only rolls on the contract
([recipe](deploying-to-aws.md#rolling-the-worker-from-ci)). The gate refuses a stack without the
`WorkerContract` output, so `cdk deploy` the template once, which adds it. A hand-installed unit
copies its `Environment=CANOPYCMS_WORKER_CONTRACT=` line from `worker/canopy-worker.service`.

**Now deletable.** Deciding from the template diff whether a bundle-only roll is safe.

### `canopycms-cdk`: `CanopyCmsService.attachTo`, and editor response headers — **behaviour change if you frame the CMS**

**What changed.** (int.94) `cmsService.attachTo(distribution, { viewerRequestFunction?, behaviorOverrides? })`
adds the editor's behaviors (`/edit`, `/edit/*`, `/api/canopycms/*`) to a distribution you already
own: OAC, the Lambda's timeout as the origin-read timeout, no caching, `x-forwarded-host`, and a
response headers policy. `CanopyCmsDistribution` sends the same headers: `frame-ancestors 'self'`,
`X-Frame-Options: SAMEORIGIN`, `nosniff`, HSTS and `X-Robots-Tag: noindex`. Unless your app sends
its own framing headers, no other origin can frame the editor or any page the CMS domain serves. Every such page is
marked `noindex`. The editor's default preview is same-origin and unaffected. See
[Serving the editor from a distribution you already own](deploying-to-aws.md#serving-the-editor-from-a-distribution-you-already-own).

**To adopt.** If you wired the Function URL into your own distribution by hand, delete those
behaviors and call `attachTo`, passing your CMS build's `assetPrefix` as `editorAssetPrefix` and a
path `editor.previewPrefix` as `previewPrefix`; synth fails while a hand-wired `/edit*`, `/api/*` or
asset-prefix behavior still sits ahead of it. Take the editor routes out of any HTTP Basic-auth
gate, and read the synth warning if your distribution has custom error responses.

**Now deletable.** Hand-wired `/edit*`, API, preview and asset-prefix behaviors, the origin, OAC and
`x-forwarded-host` function made for them, and any response-headers policy added only to stop
framing.

### `unauthenticatedStatus`: answer signed-out API calls with 419

**To adopt.** (int.102) Set `unauthenticatedStatus: 419` if your pages sit behind HTTP Basic auth on
the editor's origin; the editor still detects sign-out. Otherwise nothing.

### Auth plugins look users up in batches

**What changed.** (int.111) `AuthPlugin` gains an optional `getUsersMetadata(userIds)`, and the
editor batches its user-badge lookups.

**To adopt.** Nothing. A custom auth plugin may implement it; otherwise the server falls back to
bounded single lookups.

### The CMS image builds a prod editor, and a mode mismatch blocks the editor — **behaviour change: a hand-built image can fail its build**

**What changed.** (int.111) `Dockerfile.cms` defaults `NEXT_PUBLIC_CANOPY_MODE` to `prod`, not
`dev`, and fails its build on any value but `prod` or `dev`. An editor built for the other mode than its
server runs now gets a blocking screen naming that variable, not a sign-in that never succeeds.

**To adopt.** A hand-built image running a dev-mode server passes
`--build-arg NEXT_PUBLIC_CANOPY_MODE=dev`.

### Prod detects an unset `defaultBaseBranch` instead of assuming `main` — **behaviour change: startup can fail**

**What changed.** (int.110) Unset, prod reads the base branch from the HEAD of the workspace's `remote.git`,
which the worker points at the branch it uses. Before the worker creates `remote.git`, requests
answer the not-ready 503. A HEAD naming no branch, or a network remote, fails service creation with
an error naming `defaultBaseBranch`. `CanopyCmsService` stamps `CANOPYCMS_BASE_BRANCH` only when
`baseBranch` is set; unset, the worker uses GitHub's default branch. A stack that relied on the
implicit `'main'` behaves as before when its repository's default branch is `main`.

**To adopt.** If your base branch is not the repository's default, set `defaultBaseBranch`. Prod
does not follow a later change of GitHub's default branch, so set it before a cutover.

**Now deletable.** A `defaultBaseBranch: 'main'` in a repository whose default branch is `main`.

### The prod workspace defaults to `/mnt/efs` — **behaviour change if you run prod without `CANOPYCMS_WORKSPACE_ROOT`**

**What changed.** (int.100) With `CANOPYCMS_WORKSPACE_ROOT` unset, prod mode keeps its branches,
settings, task queue and auth cache under `/mnt/efs` instead of `/mnt/efs/workspace`
(`DEFAULT_PROD_WORKSPACE`). `CanopyCmsService` sets the variable to `/mnt/efs` in the Lambda and
the worker, so CDK deployments are unaffected.

**To adopt.** If you run prod without the CDK and without `CANOPYCMS_WORKSPACE_ROOT`, set it to
`/mnt/efs/workspace` to keep your existing workspace, or move that directory's contents up to
`/mnt/efs`.

### System health shows which build is running

**What changed.** (int.94) System health gains a Build section (canopycms version, source revision,
worker version, media-storage state) and warns when API and worker versions differ.

**To adopt.** Optional; without it the revision reads "not set". Copy the template changes
(`init-deploy aws` overwrites whole files): `Dockerfile.cms` (runner-stage `ARG`/`ENV`/`LABEL` for
`CANOPY_SOURCE_SHA`), `infrastructure/lib/cms-stack.ts` (`sourceRevision` prop, passed in
`buildArgs`), `infrastructure/bin/app.ts`, and `.github/workflows/deploy-cms.yml`
(`CANOPY_SOURCE_SHA: ${{ github.sha }}`).

**Now deletable.** Hand-rolled version or commit stamping, or a build-info endpoint.

### The AWS example workflow gains the template's triggers and dependency checks

**What changed.** (int.111) Like the one `init-deploy aws` writes, `examples/aws-deployment/deploy-cms.yml`
now deploys on `next.config.*`, `middleware.ts` and `public/**` changes, and checks `canopycms` and
`aws-cdk` are installed.

**To adopt.** If you copied it by hand, add those `paths:` and packages.

### `GET /admin/branch-health` scans for duplicate content IDs only on request — **behaviour change**

**What changed.** (int.111) The duplicate-ID scan runs only with `?duplicates=1`, under a 20 s
budget. Each healthy entry then carries `duplicateIdScan` (`none`, `found` or `unknown`), replacing
`duplicateContentIds`, and `duplicateIdScan.truncated` says whether the budget cut the scan short.

**To adopt.** Scripts reading `duplicateContentIds`: pass `duplicates=1`, read `duplicateIdScan`.

### `canopycms-cdk`: `AssetSupport` serves images from S3 only — **breaking**

**What changed.** (int.100) `/assets/*` and `/assets/t/*` come from the bucket alone, with an
optional `replicaBucket` for 5xx failover. An unmaterialized URL is a 403; no transform Lambda or
`assets/t/` expiry exists, and `transformFunction`/`transformLogGroup`/`transformFunctionUrl` are
`undefined`. `transformRole`, `transformReservedConcurrency`, `transformOutputRetention`,
`transformLogGroupName` and `transformLogRetention` throw: drop them, or set
`lazyPublicTransforms: true`.

**To adopt.** Until your pipeline runs both steps in the next entry, set
`lazyPublicTransforms: true`. Only the Lambda's writes expire, tagged `canopy-transform=lazy`; older
ones never do. On a bucket you pass in, also pass `transformOutputRetention` and filter your expiry
rule on that tag; cross-account, grant the transform role `s3:PutObjectTagging`. Then remove the
opt-in and those props, and pass `replicaBucket` if you replicate `assets/`.

**Now deletable.** Your `assets/t/` expiry rule, before leaving lazy mode.

### `collect-asset-refs` and `materialize-assets` store a build's images before release

**What changed.** (int.100) `canopycms collect-asset-refs <outDir>` writes the image keys a static
build references to `<outDir>/canopy-asset-refs.json`. `canopycms materialize-assets --refs <file>`
transforms and stores whichever of them the configured store lacks. (int.104) `collect-asset-refs`
reads a page's inline RSC payload whole, so a URL Next splits across inline scripts is never
truncated into a wrong key (`logo.sv`); a script naming `self.__next_f` that is not Next's own push
fails, naming the file and offset.

**To adopt.** Run `collect-asset-refs` after the static build, before any step that lists its files.
Run `materialize-assets` before the release is served, with the S3 grants the README lists. Every
`/assets/t/` URL a page can request must appear as text in the build output.

**Now deletable.** A pre-release warm-up step that requests image URLs to get them transformed.

### The editor and its live preview load images through the signed-in asset route

**What changed.** (int.100) The editor loads asset-store images from
`GET /api/canopycms/assets/raw/…` under your `basePath`, which transforms on demand and, on S3,
answers with a short-lived redirect to a presigned S3 read. `CanopyClientConfig.assetBaseUrl` is
gone. Inside a same-origin live preview, `assetUrl` puts `/assets/t/…` URLs behind that route
instead of your `baseUrl`.

**To adopt.** Usually nothing. The `<img>` requests authenticate with the editor's session cookie,
so the editor and its preview must share an origin with `/api/canopycms`. A Content-Security-Policy
on those pages must allow `img-src` from your bucket's S3 endpoint, and a bucket policy denying
requests that bypass CloudFront blocks the presigned reads. An off-origin preview gets no route
prefix, so under `AssetSupport`'s S3-only default it shows only stored derivatives; serve it
same-origin or set `lazyPublicTransforms: true`.

**Now deletable.** Code passing `assetBaseUrl` into the editor.

### `assetUrl` applies an image value's crop — **behaviour change for cropped images**

**What changed.** (int.100) `assetUrl`/`assetSrcSet` apply an `image` value's `crop`; `opts.crop`
overrides.

**To adopt.** Scale `<img>` `width`/`height` by `crop.w`/`crop.h`.

**Now deletable.** Copying `value.crop` into `opts.crop`.

### `media.publicBaseUrl` is removed, and image limits are wider — **breaking (config)**

**What changed.** (int.100) Nothing read `media.publicBaseUrl`, and the strict `media` schema fails a
config that sets it. Uploads go up to 24 MP (6000×4000), up from 16.7 MP. Widths are any integer up
to 8192 everywhere but the lazy Lambda, whose allowlist gains 32, 48, 64, 96 and 128 and which has
2048 MB. An `orig` over 10 MiB is accepted.

**To adopt.** Delete `publicBaseUrl`. Pass `baseUrl` to `assetUrl`/`assetSrcSet` to prefix public
asset URLs.

**Now deletable.** Anything that only fed `publicBaseUrl`, and rounding widths to a multiple of 160.

---

<!--
Template for each entry — copy, don't improvise. File it under its area heading, add a row to the
table above, and label it `(next int)`.

### <short title>

**What changed.** (next int) One or two sentences.

**To adopt.** Concrete steps, with the import path and the call shape.

**Now deletable.** The PATTERN of local code this supersedes ("a hand-rolled filename
parser"), recognisable in any adopter's tree. Never name files, paths, branches, hosts or
identifiers from an adopter's repo: this package is public and theirs generally are not. If
nothing becomes deletable, leave the part out.
-->

---

## Released

### 0.0.67

#### Clerk sign-in works behind CloudFront OAC

**What changed.** `@clerk/nextjs`'s provider makes every `setActive` (sign-in, account or org
switch) wait on a Server Action, whose POST 403s behind `CanopyCmsDistribution`'s OAC, so the wait
never ended. `canopycms-auth-clerk` skips it while the editor is mounted, and exports
`useSkipClerkSetActiveAction()` for Clerk components elsewhere in the CMS build.

**To adopt.** Nothing for the editor, if your edit page uses `useClerkAuthConfig()` or
`ClerkSignIn`. If your CMS build renders `<SignIn>`, `UserButton` or `OrganizationSwitcher` on your
own pages, mount the hook as in
[Clerk components on your own pages](../packages/canopycms-auth-clerk/README.md#clerk-components-on-your-own-pages).
Your own Server Actions in the CMS build still 403 behind OAC.

**Now deletable.** Any local patch of `window.__internal_onBeforeSetActive` (or 6.x's
`__unstable__onBeforeSetActive`), and any edge function added only to make Clerk sign-in finish.

#### The editor handles signed-out users itself, so `clerkMiddleware` is optional

**What changed.** The editor treats a 401 from the CMS API as signed out and shows the auth
provider's sign-in screen, over the open editor when a session ends mid-edit, so unsaved edits
survive signing back in. `useClerkAuthConfig()` and `useDevAuthConfig()` supply that screen. The
API verifies tokens from `CLERK_JWT_KEY` alone. `init --auth clerk` writes the same passthrough
`middleware.ts` as dev auth, with `clerkMiddleware` as a commented opt-in.

**To adopt.** Nothing, if your edit page passes one of those hooks into `config.client(...)`. A
custom auth provider adds `editor.SignInComponent`, which receives `EditorSignInProps`. `init` keeps
an existing `middleware.ts` unless you confirm or pass `--force`; either replaces an active
`clerkMiddleware`, so re-apply the commented snippet if you want the edge check.

**Now deletable.**

- A signed-out gate around the editor page, such as `<SignedOut>` wrappers or a `useAuth()` check
  rendering `<RedirectToSignIn />`, and reload-on-401 or "session expired" handling.
- A `clerkMiddleware` kept only to send signed-out visitors to sign-in, or written by an earlier
  `init` if you never chose the edge check, and with it `CLERK_SECRET_KEY` in the deployed CMS runtime.

#### A worker credential can be one field of a JSON secret

**What changed.** The EC2 worker can read one field of a Secrets Manager secret whose value is a
JSON document. Unset, the secret's whole string is the credential, byte for byte; a secret that
parses as a JSON object with no field configured logs a warning. With a field set, every miss fails
fast naming the ARN, the field and the keys present, never a value.

| `CanopyCmsService` prop         | Worker env var                             | Names a field in          |
| ------------------------------- | ------------------------------------------ | ------------------------- |
| `githubTokenSecretJsonField`    | `CANOPYCMS_GITHUB_TOKEN_SECRET_JSON_FIELD` | `githubTokenSecretArn`    |
| `clerkSecretKeySecretJsonField` | `CLERK_SECRET_KEY_SECRET_JSON_FIELD`       | `clerkSecretKeySecretArn` |

**To adopt.** Nothing, unless one of those secrets holds a JSON document: then set the matching
prop. The scaffolded stack fills them from the repository _variables_
`CANOPY_GITHUB_TOKEN_SECRET_JSON_FIELD` and `CLERK_SECRET_KEY_SECRET_JSON_FIELD`
([why the prefix](deploying-to-aws.md#repository-secrets-and-variables)); a stack scaffolded earlier
adds the props to `infrastructure/bin/app.ts` and `infrastructure/lib/cms-stack.ts` and the two `env`
lines to `.github/workflows/deploy-cms.yml`, or re-runs the generator and diffs. `cdk synth` refuses a `…JsonField` prop without its `…SecretArn`, and an ARN carrying the ECS `:KEY::` suffix
(also in `secretsArns`). Don't use CDK's `secretValueFromJson`: it resolves the plaintext into the deployed
resource's configuration, readable by anyone who can describe it. Only `CLERK_SECRET_KEY` goes through Secrets Manager; `CLERK_JWT_KEY` and the publishable
key are public material ([Security Model](deploying-to-aws.md#security-model)).

**Now deletable.** A wrapper that fetches the secret, parses it and re-exports one field into the
worker's environment, such as a `jq` step in user data or a wrapper entrypoint around
`canopy-worker`.

#### The worker can authenticate to GitHub as an App

**What changed.** The worker can act as a GitHub App installation instead of using a token.
`githubToken` is not deprecated and stays the documented default; `canopycms` neither depends on
nor imports `@octokit/auth-app`. Register one App per site, not one shared across repositories:
anyone holding an App's key can mint a token for any of its installations
([why](../ARCHITECTURE.md#why-one-github-app-per-site-not-one-shared-across-an-organisation)).

**To adopt with `canopycms-cdk`** (existing stacks need no edit). `CanopyCmsServiceProps` takes
`githubAppId`, `githubAppInstallationId`, `githubAppPrivateKeySecretArn` and
`githubAppPrivateKeySecretJsonField`, and the worker entrypoint builds the credential:

1. Register the App under your organisation, install it on the content repository with
   **Contents: read & write** and **Pull requests: read & write**, and store its PEM private key in
   Secrets Manager. `canopycms init-github-app create -- <command>` does this from a manifest: it
   pipes the key to your command's standard input (or `--key-out <path>` writes a `0600` file), and
   `verify` checks an existing installation's permissions: run it, since an App missing a
   permission only shows up later, as `sync-failed`. `create` needs an interactive terminal and
   never edits an existing JSON secret (create one and point the JSON-field prop at it)
   ([details](deploying-to-aws.md#register-it-with-canopycms-init-github-app)).
2. Set the three props and **remove `githubTokenSecretArn`** (with its JSON field). A partial set
   of the three is refused at synth, and so is an App alongside a token.
3. In the generated workflow, store them as `CANOPY_GITHUB_APP_ID`,
   `CANOPY_GITHUB_APP_INSTALLATION_ID` and `CANOPY_GITHUB_APP_PRIVATE_KEY_SECRET_ARN`: GitHub refuses
   an Actions secret or variable whose name starts with `GITHUB_`. The workflow maps each onto the
   unprefixed variable the CDK app reads. A workflow, `app.ts` or `cms-stack.ts` scaffolded before
   0.0.67 has none of this wiring: re-run `init-deploy aws` and diff.

The private key is ARN-only; passing the key itself is refused at synth. Its ARN joins the worker's
IAM policy automatically, so you need not add it to `secretsArns`. See
[Authenticating as a GitHub App](deploying-to-aws.md#authenticating-as-a-github-app).

```bash
canopycms init-github-app create -- \
  aws secretsmanager create-secret --name canopycms/github-app-key --secret-string file:///dev/stdin
```

**To adopt from your own `CmsWorker` entrypoint.** Supply `githubAppAuth` _instead of_
`githubToken`; both is rejected.

```ts
import { createAppAuth } from '@octokit/auth-app' // YOUR dependency, not canopycms's
import { CmsWorker, normalizeGitHubAppPrivateKey } from 'canopycms/worker/cms-worker'

// ONE instance: it holds the installation-token cache, so sharing it keeps the REST
// and git halves on the same hourly token.
const appAuth = createAppAuth({
  appId,
  installationId,
  privateKey: normalizeGitHubAppPrivateKey(rawPrivateKey),
})

new CmsWorker({
  ...rest,
  githubAppAuth: {
    mintInstallationToken: async () => (await appAuth({ type: 'installation' })).token,
    // A closure, not `authStrategy: createAppAuth` — that would have Octokit build a
    // SECOND instance with its own separate cache.
    octokitAuth: { authStrategy: () => appAuth, auth: {} },
  },
})
```

`normalizeGitHubAppPrivateKey` repairs `\n` escapes and base64-wrapped PEMs, converts PKCS#1 to
PKCS#8, and throws where the key is configured. The worker's git remote and REST client target
github.com. `GitHubService` stays static-token-only.

**Now deletable.** A hand-written entrypoint that existed only to get App auth onto a CDK
deployment; user-data steps that fetched the PEM into the worker's environment; your own PEM
conversion; code that mints a token at boot and holds it (installation tokens last about an hour);
a wrapper that catches and re-throws a mint failure, which drops the HTTP status the task
classifier reads, so a bad key burns every publish's retry budget; and a runbook step that
downloads the `.pem` from the App's settings page.

#### A rotated secret reaches the running worker, without an instance replacement

**What changed.** The worker re-reads a Secrets Manager secret (the GitHub token or the Clerk secret
key) when the operation using it fails. Timings, costs and the store-before-revoke order are in
[Rotating a secret](deploying-to-aws.md#rotating-a-secret).

**To adopt.** Nothing for credentials from `*_SECRET_ARN`, which is every scaffolded deployment. A
GitHub App private key is still read only at boot: store the new key, replace the instance, and
only then delete the old key on GitHub. A plain env var (`CANOPYCMS_GITHUB_TOKEN`,
`CLERK_SECRET_KEY`) is never re-read.

A custom `CmsWorker` entrypoint can pass `refreshGitHubToken?: () => Promise<string | undefined>`,
returning the new token or `undefined` for nothing to do. Core calls it after a failed git sync or
task, at most once per `refreshGitHubTokenMinIntervalMs` (default `60000`; `0` disables it), and
abandons a call still unsettled after `taskTimeoutMs`. Clerk's cache refreshes through
`refreshAuthCache`. `packages/canopycms-cdk/worker/credential-refresh.ts` is the worked example.

**Now deletable.** Automation that runs `cdk deploy` or an instance refresh after rotating a secret
only to pick it up, unless it is for a GitHub App private key.

#### `assetUploadBehavior()` builds the upload route from a bucket alone

**What changed.** `canopycms-cdk` exports a free function taking the same options as
`AssetSupportProps.uploadBehavior` plus the `bucket`:

```ts
import { assetUploadBehavior } from 'canopycms-cdk'

const uploads = new cloudfront.Distribution(this, 'AssetUploads', {
  defaultBehavior: assetUploadBehavior(this, { bucket: assetBucket }),
})
// media.uploadUrl = `https://${uploads.distributionDomainName}/`
```

**To adopt.** Optional. Don't move an existing deployment from `AssetSupport.uploadBehavior()` to
the function: its three CloudFront resources would get new logical IDs and be replaced.

**Now deletable.** An `AssetSupport` instantiated only to reach `uploadBehavior()`. Cross-account,
also check the bucket policy for its grant.

#### The CMS image builds without git, `CanopyCmsService` defaults to arm64, and the CDK app is type-checked — **breaking (deploy), for a stack that sets `platform` without `architecture`**

**What changed.** Mostly for stacks from an earlier `canopycms init-deploy aws` or a hand-copied
`Dockerfile.cms.template`:

1. `next build` reads content from the build context's working tree, never git, a branch clone or
   `.canopy-dev`. The generated `Dockerfile.cms` builder stage installs no git, commits no snapshot
   repository, and sets `ENV CANOPY_BUILD_MODE=true`; the runner stage still installs git.
2. The pnpm Dockerfile copies `pnpm-workspace.yaml` before installing; pnpm 11 keeps its
   `allowBuilds` decisions there.
3. `init-deploy aws` keeps `infrastructure/` out of the app's `tsconfig.json` and `.dockerignore`,
   and the generated workflow type-checks it with `tsc --noEmit -p infrastructure` (tsx, which
   `cdk.json` runs, drops a misspelled prop silently).
4. `CanopyCmsService` defaults to `Architecture.ARM_64` and passes it to the function, from which
   CDK derives a `fromImageAsset` image's platform; the workflow runs on `ubuntu-24.04-arm`.
5. `withCanopy()` adds sharp's libvips to Next's file tracing (not for a static export) and, on
   Next 16 and later, sets `turbopack: {}` when your config has neither `turbopack` nor your own
   `webpack` and it can read your Next version. A webpack build still fails its image transforms
   ([Dual Build Support](deploying-to-aws.md#dual-build-support)).

**Breaking:** a stack setting `platform` on `fromImageAsset` without `architecture` gets an arm64
function while `platform` still decides the image, so `Platform.LINUX_AMD64` builds an image the
function cannot run. A stack setting neither moves to arm64 with a matching image, built under QEMU
on an x86 host ([Where the image is built](deploying-to-aws.md#where-the-image-is-built)).

**To adopt.**

1. Delete `platform` from `fromImageAsset` with its `Platform` import; set `architecture` on
   `CanopyCmsService` only if you want x86_64.
2. Re-run `canopycms init-deploy aws`. It asks before replacing each existing file
   (`--non-interactive` skips them, `--force` replaces everything, including an edited stack), and
   always adds `infrastructure/tsconfig.json`, and the `exclude` entry unless `tsconfig.json` is
   missing, isn't plain JSON, or inherits `exclude` through `extends` (it then tells you to add it). In files you keep, bring
   across: the workflow's "Type-check the CDK app" step before "Configure AWS credentials", with
   `tsconfig.json` in `on.push.paths` (`examples/aws-deployment/deploy-cms.yml` has both);
   `runs-on: ubuntu-24.04-arm`; an `infrastructure` line in `.dockerignore`; and, with pnpm,
   `pnpm-workspace.yam[l]` in the Dockerfile's first `COPY`.
3. A hand-copied `Dockerfile.cms` builds as before; when convenient, delete the builder's git
   install and snapshot commit and add `ENV CANOPY_BUILD_MODE=true` before the build command.

**Now deletable.** The builder's git install and snapshot commit, and any step creating or checking
out the base branch so the build could find it; CI steps attaching a detached HEAD for the same
reason; `platform` on `fromImageAsset`; and, with `withCanopy()`, a hand-written
`outputFileTracingIncludes` entry for libvips and a `turbopack: {}` added only for Next 16's error
(unless under Yarn PnP, where `withCanopy()` cannot read your Next version).

### 0.0.66

#### `media.uploadUrl` routes presigned uploads through your own CDN (#44)

**What changed.** `media.uploadUrl` (s3 adapter; an absolute http(s) URL or a site-relative path)
replaces the `url` that `beginUpload()` returns, leaving the presign's `fields` untouched, so
uploads can be same-origin. See [Media Configuration](../README.md#media-configuration) for the
CloudFront behavior it expects.

**To adopt.** Optional. Set it from an environment variable: a site-relative value works only where
that path routes to the bucket, so it 404s under `next dev`.

**Now deletable.** The bucket CORS rule naming your editor's origin, once uploads are same-origin.
`AssetSupport`'s `editorOrigins` is then unused; standalone mode still needs either it or
`uploadBehavior`.

#### `media` config rejects unknown keys

**What changed.** Each branch of `mediaSchema` is `.strict()`, so a misspelled key under `media`
fails validation, naming it.

**To adopt.** Fix or remove the key.

#### `AssetSupport` and `CanopyCmsService` take an execution role, so its ARN is derivable without a construct reference (#42)

**What changed.** `CanopyCmsServiceProps.lambdaRole?: iam.Role` (and
`AssetSupportProps.transformRole`, which since [S3-only assets](#canopycms-cdk-assetsupport-serves-images-from-s3-only--breaking)
needs `lazyPublicTransforms: true`) let you pass a deterministically named role, so a cross-account
bucket's stack computes `arn:aws:iam::<account>:role/<name>` from literals instead of a
`Fn::GetStackOutput` reference only the CDK CLI resolves. The constructs re-attach
`AWSLambdaBasicExecutionRole` (and the VPC policy) that `lambda.Function` drops from a role you
pass. See [Cross-account asset bucket](deploying-to-aws.md#cross-account-asset-bucket).

**To adopt.** Optional:

```ts
const roleName = `canopy-cms-${tier}` // derive it however you name things
const role = new iam.Role(this, 'CmsRole', {
  roleName,
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
})
new CanopyCmsService(this, 'Cms', { /* ... */ lambdaRole: role })

// In the bucket's stack, in the other account - no reference, just literals:
const principal = new iam.ArnPrincipal(`arn:aws:iam::${tierAccount}:role/${roleName}`)
```

A named role needs `CAPABILITY_NAMED_IAM` and cannot be replaced in place without a rename. The type
is `iam.Role`, not `IRole`: `addManagedPolicy` does nothing on an imported role, so create the role
in the compute's stack rather than passing `Role.fromRoleArn`.

**Now deletable.** A `Fn::GetStackOutput`-producing cross-stack reference, a `CfnOutput`-plus-manual
wiring step, or an asset grant scoped to the whole compute account because the role could not be
named.

#### `AssetSupport.attachTo()` and `CanopyCmsDistribution`'s `assetSupport` prop order the asset behaviors for you (#41)

**What changed.** CloudFront takes the first matching behavior, so `/assets/*` listed before
`/assets/t/*` (as alphabetizing does) sends every derivative to the wrong behavior.
`AssetSupport.attachTo(distribution, overrides?)` adds `/assets/t/*` then `/assets/*`, merging
`overrides` (`Partial<cloudfront.AddBehaviorOptions>`) into both. `CanopyCmsDistribution` takes
`assetSupport` and `assetBehaviorOverrides` and calls it for you. Its synth checks refuse
`/assets/*` before `/assets/t/*`, the literal `assets`/`assetsTransform` keys spread from
`assetBehaviors()`, `assetSupport` while `additionalBehaviors` still lists an asset pattern, and
`assetBehaviorOverrides` without `assetSupport`. `assetBehaviors()` is unchanged, and a bespoke
`cloudfront.Distribution` calls `attachTo()` directly.

**To adopt.** Optional, but don't do half of it. Replace a hand-written

```typescript
additionalBehaviors: {
  '/assets/t/*': assetSupport.assetBehaviors().assetsTransform,
  '/assets/*': assetSupport.assetBehaviors().assets,
},
```

with the prop, carrying any per-behavior options (such as a tier's basic-auth viewer-request
function, without which `/assets/*` is anonymously readable) as overrides:

```ts
new CanopyCmsDistribution(this, 'Dist', {
  ...yourExistingDistributionProps,
  assetSupport,
  assetBehaviorOverrides: {
    functionAssociations: [{ function: tierAuthFn, eventType: FunctionEventType.VIEWER_REQUEST }],
  },
})
// on a bespoke distribution, pass the same object as attachTo's second argument
```

**Now deletable.** The hand-ordered `additionalBehaviors` block, and comments reminding you of the
order. Keep `assetBehaviors()` only if the two behaviors must differ, with your own assertion on
the synthesized `CacheBehaviors` order.

#### `canopycms-auth-clerk` supports Clerk Core 3 (`@clerk/nextjs` 7.x, `@clerk/backend` 3.x)

**What changed.** Peer ranges are `@clerk/nextjs: ^6.0.0 || ^7.0.0` and
`@clerk/backend: ^2.0.0 || ^3.0.0`. Networkless `verifyToken` PEM verification still works.

**To adopt.** Optional. Core 3 needs `<ClerkProvider>` inside `<body>`, not around `<html>`
(`apps/example1/app/layout.tsx`); a dual-build editor layout is already inside `<body>`. If you
render `AccountComponent` yourself with `afterSignOutUrl`/`signOutUrl`, move them to
`ClerkProvider`'s `afterSignOutUrl` or a `SignOutButton`. If you keep `clerkMiddleware`, it needs a non-empty `secretKey`.
`CLERK_ENCRYPTION_KEY` does not apply to
the scaffold's commented `clerkMiddleware` snippet, which passes only `jwtKey`. Node must be >= 22.12.0 for every CanopyCMS
package regardless.

```tsx
<html lang="en">
  <body>
    <ClerkProvider>{children}</ClerkProvider>
  </body>
</html>
```

#### `CanopyCmsService` gains `settingsBranch`, and the generated stack derives both branches from `canopycms.config.ts` (#39)

**What changed.** `settingsBranch` sets the worker's `CANOPYCMS_SETTINGS_BRANCH`; it and
`baseBranch` are checked against git's branch-name rules at synth. The generated
`infrastructure/lib/cms-stack.ts` imports `canopycms.config.ts` and passes
`baseBranch: canopyConfig.server.defaultBaseBranch` and
`settingsBranch: canopyConfig.server.settingsBranch`.

**To adopt.** Regenerate `cms-stack.ts` or copy the import and two lines; your own stack sets both
props to match `canopycms.config.ts`. **Do this now if your default branch is not `main` or you set
`settingsBranch`**: the worker otherwise exits at start or syncs a different settings branch than
the Lambda writes. From int.110, prod detects an unset base branch from the repository's
default branch ([Prod detects an unset `defaultBaseBranch`](#prod-detects-an-unset-defaultbasebranch-instead-of-assuming-main--behaviour-change-startup-can-fail)).

**Now deletable.** Runbook steps keeping `CANOPYCMS_BASE_BRANCH` or a settings-branch override in
sync with `canopycms.config.ts` by hand.

#### `CLERK_JWT_KEY` is a repository **variable**, not a secret (#37)

**What changed.** The generated `deploy-cms.yml` reads `${{ vars.CLERK_JWT_KEY }}`: it is Clerk's
public JWKS PEM, used only to verify signatures.

**To adopt.** If you regenerate or copy the workflow, move `CLERK_JWT_KEY` from repository secrets
to variables (Settings → Secrets and variables → Actions → Variables); `bin/app.ts` refuses the
deploy at synth while it is unset. Check that `bin/app.ts` passes `CLERK_SECRET_KEY` as
`clerkSecretKeySecretArn` (read by the worker), never in the Lambda's `environment`, unless you keep
`clerkMiddleware` ([Security Model](deploying-to-aws.md#security-model)).

#### `readByUrlPath` answers only where `listEntries` publishes — **breaking (routing)**

**What changed.** For every entry, `readByUrlPath(item.urlPath)` reaches it and no other URL does.
These now return `null`: `/<collection>/<entryTypeName>` (which reached the collection's index
entry) and `/<collection>/<entryTypeName>/<slug>`; and an entry whose type token on disk its
collection does not declare (a type renamed without renaming files, or a collection declaring no
entry types); such entries were already missing from listings, static params and the sitemap.
Those entries stay editable, renameable and deletable. `read({ entryPath: 'content/home' })` still
addresses a singleton, defaulting the slug to the entry type's name. A legacy untyped file
(`overview.json`) is still readable by URL but invisible to listings; rename it into the
`{type}.{slug}.{id}.{ext}` grammar.

**To adopt.** On a catch-all route, request `/<collection>/<entryTypeName>` and
`/<collection>/<entryTypeName>/<some-slug>` for a few type names and confirm a 404 (under
`next dev` or `output: 'standalone'` they were served). If you renamed an entry type without
renaming its files, rename them or declare the type. A build does not flag them; they are the files missing from
`listEntries()`.

**Now deletable.** Per-route `entryType` gates that only reject a URL that should not have resolved
(keep a branch that dispatches between templates), catch-all filters dropping entry-type names, and
tests asserting a specific phantom URL returns `null`.

#### Static exports are reproducible: `CANOPY_BUILD_ID` pins the build id, and the AI manifest stops baking a wall clock — **breaking (type-level)**

**What changed.** `withCanopy(..., { staticBuild: true })` uses `CANOPY_BUILD_ID` as Next's build id
(your own `generateBuildId` still wins; non-static builds ignore it). `generate-ai-content` records
`buildId` from it in `public/ai/manifest.json`, and pins `generated` to `SOURCE_DATE_EPOCH`, or
omits it when a build id is set without one. `AIManifest.generated` is `string | undefined`.

**To adopt.** Guard reads of `AIManifest.generated`. To make an export reproducible, export
`CANOPY_BUILD_ID` for both `next build` and `generate-ai-content`, and `SOURCE_DATE_EPOCH` to keep
the manifest's timestamp. The id is 1-255 characters of `[A-Za-z0-9._-]`, not `.` or `..`; an
unusable value is ignored with a warning. Derive it from a tree hash, not a commit SHA or date,
which a rebase changes for an identical tree.

**Now deletable.** A `generateBuildId: () => process.env.<YOUR_VAR> || null` line, **only if** you
pass `{ staticBuild: true }` (on other builds it un-pins the id). Written with `??`, such a line
ships an empty build id from an empty variable. Also a post-build step rewriting the manifest's
`generated`.

### 0.0.65

#### `canopycms-cdk`: CloudFront waits as long as the CMS Lambda, and the worker boots from AL2023's Node 22

**What changed.**

- `CanopyCmsDistribution` takes `originReadTimeout`, defaulting to 60 seconds, the CMS Lambda's
  default `timeout` (`cmsService.timeout` exposes the actual one); synth refuses more than 60
  seconds. Without a `certificate`, it refuses a stack region other than `us-east-1`, where
  CloudFront needs its certificate, when the region is known at synth.
- The worker installs Node 22 with `dnf` and runs `/usr/bin/node-22`; a failed boot step shuts the
  instance down so the group replaces it. Its IAM policy covers `githubTokenSecretArn` and
  `clerkSecretKeySecretArn` as well as `secretsArns`. The bot token never stays in
  `remote.git`'s config on EFS, and one an earlier worker left there is scrubbed.
- An `/assets/t/` URL whose slug is not the asset's own answers 404; `assetUrl` keeps the stored
  `src`'s slug, so the URLs it builds are unaffected.
- `canopycms worker run-once` exits 1 on an unknown `CANOPY_AUTH_MODE`.

**To adopt.** If you override `CanopyCmsService`'s `timeout`, pass
`originReadTimeout: cmsService.timeout` (the generated stack does). A hand-installed worker runs
`dnf install -y nodejs22` and sets `ExecStart=/usr/bin/node-22 index.js`. The generated
workflow reads the bot-token ARN from the secret `CANOPY_GITHUB_TOKEN_SECRET_ARN` (GitHub refuses
`GITHUB_`-prefixed names): store it under that name. In a kept `Dockerfile.cms`, change both
`node:20-slim` stages to `node:22-slim`; in `deploy-cms.yml`, set `node-version: 22`.

#### `canopycms init` scaffold fixes

**What changed.** `init` writes `middleware.ts` in the app directory's parent (`src/` for
`--app-dir src/app`), leaves an existing `next.config.js`/`.mjs` alone and prints the wiring,
creates `.gitignore` with `.canopy-dev/` when absent, and the generated workflow deploys on
`next.config.*`, `middleware.ts` and `public/**` changes.

**To adopt.** Check what an earlier `init` left: a `middleware.ts` at the root of a `src/app`
project, which Next never loads (move it into `src/`); a `next.config.ts` beside a `.js`/`.mjs`
config, which Next ignores (wrap the loaded one in `withCanopy` and delete it); `.canopy-dev/`
missing from `.gitignore`; and those three paths missing from `deploy-cms.yml`'s `on.push.paths`.

### 0.0.64

#### `basePath` deployments are supported, and `assetUrl`'s `baseUrl` is now safe for path prefixes (#24)

**What changed.** `assetUrl()`/`assetSrcSet()`'s `baseUrl` accepts a same-origin path prefix
(`'/preview-123'`): an absolute `src` is returned untouched, and a prefix without a leading slash is
normalized. A top-level `basePath` config key makes the editor's API calls and preview pane work
under a Next.js `basePath`.

**To adopt.** Under a `basePath`, state it in your Canopy config too (CanopyCMS cannot read
`next.config`):

```typescript
// canopycms.config.ts
basePath: process.env.NEXT_PUBLIC_BASE_PATH,
```

Then pass `baseUrl` to `assetUrl` only if Next serves `/assets` (local adapter, `next dev`, S3 with
no distribution): `assetUrl(image, { width: 960, baseUrl: BASE_PATH })`. Assets on CloudFront via
`AssetSupport` stay at the distribution root; pass no `baseUrl` (mount table under "Where `/assets`
is mounted" in [Media Configuration](../README.md#media-configuration)). Two traps:

- Don't pass a deployment `basePath` to `contentStaticParams({ basePath })`; that option filters by
  a nested route prefix and emits zero params, building green.
- Body images bypass `assetUrl()`; under a `basePath` they need the README's `img` override, which
  roots a page-relative src onto the base, so make those root-relative first.

**Now deletable.** A prefixing wrapper re-exporting `assetUrl`/`assetSrcSet`, and a local "strip
trailing slashes" helper (`stripTrailingSlashes` is in `canopycms/server`).

#### `select` fields infer their own options — **breaking (type-level)**

**What changed.** `TypeFromEntrySchema` infers a `select` as the literal union of its options'
values (`'draft' | 'published'`), not `string | number`. Options must be literals at the type level
(`defineEntrySchema` or `as const`); an array typed `SelectOption[]`, or no options, falls back to
`string`. `''` is not in the union, though the validator accepts it for any field not marked
`required: true`: compare cleared
values before they reach the typed surface, or add `''` to the options.

**To adopt.** Fix comparisons against strings that are not options (now "no overlap" errors), and
assignments of a plain `string` into a select value. Rename a custom field type's own `options`
property, which is now a reserved key. Grep for `typeof value === 'number'` branches, which now
narrow to `never` silently.

**Now deletable.** Casts or allowlists re-narrowing a select value to the app's own union, and
`typeof v === 'string'` guards that only stripped `number`.

#### Listings resolve references, and a resolved reference carries `urlPath` and optionally its body (#16) — **breaking (type-level)**

**What changed.**

- `listEntries()`, `buildContentTree()` and `collectRoutableEntries` take `resolveReferences`
  (default `false`; `read()`'s is `true`), resolving references at any depth, including in blocks,
  at one read per distinct target per call. Path ACLs are not applied to resolved targets, as with
  `read()`.
- Every resolved reference carries `urlPath`, the same URL `listEntries` publishes.
- `includeBody: true` on a reference field adds the target's body, under the target type's body
  field name.
- `TypeFromEntrySchema` adds `ResolvedReferenceMeta` (`id`, `slug`, `collection`, `urlPath`), which
  are reserved: they win over target fields of those names; read the target directly for its own
  field.
- A save collapses a resolved reference back to its id. A reference saved through the editor on an
  earlier version may hold an object instead of a 12-character id (replace it with its own `id`), or
  `null` where its target had been deleted (the id is only in git history).

For what a target the reader may not see, or a missing one, resolves to, see
[References](#a-reference-resolves-to-its-target-a-restricted-stub-or-a-missing-stub--security-fix-breaking-types-and-build).

**To adopt.** Turn on `resolveReferences` for surfaces that read inside references (search indexes,
feeds); leave it off for static params and sitemaps. Add `& ResolvedReferenceMeta` (from
`canopycms`) where an exact-shape type stops compiling. Set `includeBody: true` on fields whose
target prose you render, or leave the body field out of `resolvedSchema`.

```ts
const entries = await ctx.listEntries({ resolveReferences: true })
```

**Now deletable.** A second `read()` pass over a listing to resolve ids, a surface rebuilt on
per-entry `read()` to dodge the gap, a contentId → URL index built by a second content pass,
`resolveReferences: false` forced by that index, and a follow-up `read()` only for a target's body.

#### Editor saves keep comments, and report content keys the schema does not define (#29)

**What changed.** A save re-serialises onto the file's parsed document, so YAML and frontmatter
comments survive ([int.101 extends this to formatting](#a-save-rewrites-only-what-changed)). Unknown
content keys come back as `validationWarnings` on save ("Saved with warnings"), and a production
build's `collectStaticPaths`/`collectRoutableEntries` print one warning listing them by path. Nothing
is rejected or stripped.

**To adopt.** Expect the first build to list keys you no longer use: add each to the schema or
delete it.

**Now deletable.** Conventions keeping notes out of content files, scripts diffing content keys
against a schema, and `?? fallback`s kept because nobody knew whether a field was populated.

#### An `index` entry answers only at its collection's URL, and a contested URL fails the build — **breaking (routing)**

**What changed.** `readByUrlPath('/guides/index')` (any case) returns `null`; the index entry
answers at `/guides`. A collection named `index` resolves at `/x/index` to its own index entry. A
production build fails when two entries compute the same `urlPath`, listing each; creating or
renaming an entry into one is refused with 409, renaming a collection into one with 400. An entry
beside a same-named sibling collection with no index entry is not contested. A save of an entry
already contested still succeeds. `read()`/`readByUrlPath()` `path` collapses an index slug and
strips the content root from root-level entries.
[0.0.66](#readbyurlpath-answers-only-where-listentries-publishes--breaking-routing) closes the
remaining extra URLs.

**To adopt.** A `shape: 'single'` (`[slug]`) static-params route no longer emits the collection's
index entry, so that page can silently stop building: move it to the collection's own route
(`app/posts/page.tsx`). For a contested URL, rename or remove one of each pair. A hand-rolled
`generateStaticParams` over `listEntries` doesn't fail; call `findDuplicateUrlPaths` there, over
`listEntries()` (`collectRoutableEntries()` drops the `entryPath` naming the offenders):

```ts
import { findDuplicateUrlPaths } from 'canopycms/server'

const canopy = await getCanopyForBuild()
const duplicates = findDuplicateUrlPaths(await canopy.listEntries())
```

**Now deletable.** Route guards rejecting a `.../index` URL, duplicate-URL integrity tests, and
editor-side checks for a contested URL.

#### Sitemap `pathFor`, and modelling a page served at `/` as a root `index` entry

**What changed.** An entry with slug `index` answers at its collection's path (`/` at the root). For a URL that
can't be modelled, `generateContentSitemap` takes `pathFor: (entry) => string | null`, keeping the
entry's `noindex`, `lastModified` and `priority` handling; `null` keeps the structural path, and an
empty string throws. `extraUrls` is for URLs with no entry behind them.

**To adopt.** To re-model a singleton served at its collection's path (such as home at `/`):

1. `git mv home.home.<id>.json home.index.<id>.json`; type and id are unchanged.
2. Change `read({ entryPath: 'content/home' })` to `readByUrlPath('/')` (`'/<collection>'`
   elsewhere), or pass `slug: 'index'`.
   Otherwise the build is green with a 404 at `/`: check the emitted HTML.
3. Drop the sitemap workaround and check `sitemap.xml`; redirect the old URL if it was indexed.

```ts
pathFor: (entry) =>
  entry.entryType === 'article' ? entry.urlPath.replace(/^\/articles\//, '/blog/') : null,
```

**Now deletable.** An `exclude` plus `extraUrls` pair re-adding a page's real URL, and hand-derived
`noindex`/`lastModified` beside an extra URL.

#### A slug that cannot round-trip through a URL fails the build, and the CMS refuses to create one — **breaking (build)**

**What changed.** A slug must be lowercase letters, numbers and hyphens, starting with a letter or
number, and at most 64 characters. A production build fails listing every entry whose slug isn't (such as
`post.getting.started.guide.<id>.md`, which built and then 404'd), and a create or rename to one is
refused with 400. Existing entries stay readable and renameable.

**To adopt.** Build once; rename the slug segment of each listed file
(`post.getting-started-guide.<id>.md`), in the editor or with `git mv`, and fix hand-written links.
Slugify generated content the same way.

**Now deletable.** CI checks walking filenames for unservable slugs, and editor-side slug checks.

### 0.0.63

#### `required: false` infers an optional property (#14) — **breaking (type-level)**

**What changed.** `TypeFromEntrySchema` emits an explicitly `required: false` field as `name?: T`,
at every level, instead of `name: T | undefined`. A field omitting `required` is still required.

**To adopt.** Change hand-written interfaces declaring `subheading: string | undefined` to
`subheading?: string` (or derive them from the schema). Audit `Required<…>` on schema-derived types.
Under `exactOptionalPropertyTypes: true`, omit keys instead of assigning `undefined`, and use
`skipLibCheck: true` (the Next.js default): with `skipLibCheck: false` the package does not compile.

**Now deletable.** `: undefined,` lines that only satisfied a `required: false` field.

#### Sitemap and SEO metadata helpers (#10, #10a)

**What changed.** `collectRoutableEntries`, `extractSeoFields`, `isNoindexEntry`, `resolveSeoUrl`,
`withTrailingSlash` and `isAbsoluteUrl` from `canopycms/server`; `defineSeoFieldGroup()` from
`canopycms`; `generateContentSitemap` and `entryToMetadata` from `canopycms-next`, bound on
`createNextCanopyContext`'s result. See
[Sitemap and SEO Metadata](../README.md#sitemap-and-seo-metadata). Every routable entry type is in
the sitemap unless `exclude`d or `noindex`; one `noindex` predicate drives both robots metadata and
sitemap exclusion. `trailingSlash` is never inferred. `lastModified` defaults to `updatedAt`, a
filesystem mtime. An empty SEO field counts as unset. `siteUrl` must be absolute, colliding URLs are
deduped with a warning, and a schema-invalid or unparseable content file fails a production build,
sitemap included.

**To adopt.**

```ts
// app/lib/canopy.ts — bind the sitemap helper once
export const contentSitemap = async (options: GenerateContentSitemapOptions) => {
  const context = await canopyContextPromise
  return context.generateContentSitemap(options)
}

// app/sitemap.ts
export const dynamic = 'force-static' // required for output: 'export'
export default () =>
  contentSitemap({
    siteUrl: SITE_URL,
    trailingSlash: true, // match your framework's routing config
    exclude: (entry) => entry.entryType === 'author', // types with no page of their own
  })

// app/posts/[slug]/page.tsx — without the type argument `result.data` is `unknown`
const result = await readByUrlPath<PostContent>(`/posts/${slug}`)
return entryToMetadata(result?.data, {
  path: `/posts/${slug}`,
  siteUrl: SITE_URL,
  fallbackTitle: result?.data.title,
})
```

Exclude entry types with no page of their own. Pass `seo` once to `createNextCanopyContext`, not
per call. With `defineSeoFieldGroup({ group: 'seo' })`, include the same `group` in
that `seo` option. Add `defineSeoFieldGroup()` to schemas with SEO fields; map an existing group with
`seo: { fields: { title: 'yourName' } }` rather than keeping both. Pass a `lastModified` callback for a
real content date, or return `undefined` from it to omit `<lastmod>`. Write `app/robots.ts` yourself.

**Now deletable.** A sitemap over a hardcoded list of entry types, a hand-written `Metadata` mapper,
a local `withTrailingSlash`/`absoluteUrl` pair, and a content walk only for sitemap dates.

#### The build guard ignores files that were never entry-shaped

**What changed.** The build fails only on a file that could have been an entry: four or more
dot-separated segments, or three whose first names an entry type in that collection. A
`README.md` or a `5NVkkrB1MJUv.profile.json` sibling artifact builds clean; dot- and
underscore-prefixed files are skipped.

**To adopt.** Move back, or rename back, a sibling artifact you moved or renamed to dodge the guard;
`readSibling` reads it beside its entry.

#### `canopycms init` scaffolds `defaultBranchAccess: 'deny'` and public read

**What changed.** New scaffolds write `defaultBranchAccess: 'deny'` and
`defaultPathAccess: { read: 'allow' }`
([Public read on server deployments](../README.md#public-read-on-server-deployments)).

**To adopt.** An older scaffold's `defaultBranchAccess: 'allow'` is wider than recommended;
consider `'deny'`. If you deleted `defaultPathAccess: { read: 'allow' }`, anonymous visitors get no content until you
restore it: `readByUrlPath` pages 404 and `read()` throws; non-admin signed-in users without a path rule get 403 from
the API.

#### Read and listing helpers replace hand-rolled parsing (#1, #2, #3, #4, #17)

**What changed.**

| API                                                        | From                 | Replaces                                                   |
| ---------------------------------------------------------- | -------------------- | ---------------------------------------------------------- |
| `parseTypedFilename(name, entryTypes?)`                    | `canopycms/server`   | splitting `{type}.{slug}.{id}.{ext}` filenames             |
| `defaultBuildPath(path, root, kind)`                       | `canopycms/server`   | a copy of `buildContentTree`'s default `buildPath`         |
| `meta.entryType`, `meta.entryId` on `read`/`readByUrlPath` | —                    | parsing type or id out of `meta.physicalPath`              |
| `updatedAt` on `listEntries` items                         | —                    | an `fs.stat` walk of the content root                      |
| `createBuildCanopy(config, options)`                       | `canopycms/server`   | a script's own services + context + admin-user boot        |
| `resolveEntryTitle(data, options)`                         | `canopycms(/server)` | a `title ?? name ?? humanize(slug)` chain                  |
| `toPlainText(markdown)`                                    | `canopycms/ai`       | a Markdown/MDX stripper that drops custom components' text |

`parseTypedFilename` returns `null` for an id that isn't 12-character Base58 (no `0 O I l`).
`meta.entryType` comes from the filename: for a legacy `{slug}.{ext}` file it is the collection's
default type and `entryId` is `undefined`, and it may name a type the schema no longer declares.
`updatedAt` is a filesystem mtime, reset by a fresh clone. `createBuildCanopy` bypasses all ACLs:
scripts only, never request handling. `buildPath` still replaces the default rather than composing
with it. Composing search documents is left to you; these are the shared pieces. To find a filename
parser, look for `.split('.')` or `lastIndexOf('.')` on content filenames, often in link-check or
slug-collision tests.

**To adopt.**

```ts
import { createBuildCanopy, resolveEntryTitle } from 'canopycms/server'
import { toPlainText } from 'canopycms/ai'

const canopy = await createBuildCanopy(config.server, { entrySchemaRegistry })
for (const entry of await canopy.listEntries()) {
  const title = resolveEntryTitle(entry.data, { schema: entry.schema })
  const body = typeof entry.data.body === 'string' ? toPlainText(entry.data.body) : ''
}
```

Dispatch on `result.meta.entryType` with a default case.

**Now deletable.** Each "Replaces" column above, plus route-level guard-and-delegate blocks that
re-checked an entry's type (a `switch` on `meta.entryType` can merge them into one catch-all).

#### `BlockComponentRegistry`: exhaustive block → component types (#13)

**What changed.** `BlockComponentRegistry<Blocks>` (types only, from `canopycms`; `BlockValueOf<Blocks, 'hero'>`
gives one template's value type) requires exactly
one component per block template name when written as an object literal. See
[Block Component Registries](../README.md#block-component-registries) and
`apps/example1/app/components/PostView.tsx`.

```ts
import type { BlockComponentRegistry } from 'canopycms'

type Blocks = Page['blocks'][number]

const blockRegistry: BlockComponentRegistry<Blocks> = {
  hero: ({ data }) => <HeroSection headline={data.headline} />,
  cta: ({ data }) => <CtaSection title={data.title} />,
  // Missing a key here, or a key that doesn't match a template name, is a compile error.
}
```

**Now deletable.** A `switch (block.template)` with a silent `default`, and tests matching handled
templates against the schema.

#### Reusable field fragments, plus `defineFieldFragment()` (#15)

**What changed.** Spreading a `const` field array into several schemas, and nesting
`defineInlineFieldGroup()` inside a block template, are documented
([Reusable Field Fragments](../README.md#reusable-field-fragments)); `defineFieldFragment()` is an
identity helper for them.

```ts
const ctaFields = defineFieldFragment([
  { name: 'ctaLabel', type: 'string' },
  { name: 'ctaHref', type: 'string' },
])
const heroSchema = defineEntrySchema([{ name: 'headline', type: 'string' }, ...ctaFields])
```

**Now deletable.** A field cluster spelled out by hand in several schemas; override a differing
field by composing from the same `const` field object.

#### Shared/referenced blocks are documented (#16)

A block template holding a `reference` field is a shared block; `read()`/`readByUrlPath()` resolve
it, and listings do with
[`resolveReferences`](#listings-resolve-references-and-a-resolved-reference-carries-urlpath-and-optionally-its-body-16--breaking-type-level)
(0.0.64). See [Shared / Referenced Blocks](../README.md#shared--referenced-blocks).

**Now deletable.** A second `read()` in page code to unwrap a shared block's reference.

#### `checkPathAccess` removed from `CanopyServices`

**What changed.** It was bound with an empty rule set, so it always returned the default decision.

**To adopt.** Replace `context.services.checkPathAccess` with
`context.services.createContentAccessChecker(...)`, which resolves the real rules.

### 0.0.62 and earlier

Not retro-documented, apart from these:

- **`rich-text` was removed** (breaking). Change a `type: 'rich-text'` field to `type: 'markdown'`.
- **Content IDs are 12-character Base58** without `0 O I l`. An entry with a hand-rolled ID
  containing one never loads: it is skipped silently in the editor and `next dev`, and fails a
  production build. Use `generateId()` from `canopycms/server`.

#### The registry is keyed by entry-type name (0.0.42)

**What changed.** `createEntrySchemaRegistry` keys are the entry-type names that `.collection.json` files name in `entry.schema`, and `EntryTypesFromRegistry` derives the typed entry-type map from them. Schema-variable keys (`{ postSchema }`) still work but derive nothing; [README's registry convention](../README.md#convention-why-key-the-registry-by-entry-type-name) says when to keep them.

**To adopt.**

1. Rename the keys in `schemas.ts`: `{ postSchema, authorSchema }` becomes `{ post: postSchema, author: authorSchema }`.
2. Rename every `entry.schema` string in `content/**/.collection.json` to match (`"schema": "postSchema"` becomes `"schema": "post"`), then confirm nothing is left with `grep -r 'Schema"' content/`.
3. Add `export type EntryTypes = EntryTypesFromRegistry<typeof entrySchemaRegistry>` and derive the per-schema aliases from it (`type PostContent = EntryTypes['post']`).
4. Pass `EntryTypes` as the second generic wherever you call `buildContentTree`, so `meta.indexEntry.data` narrows on `meta.indexEntry.entryType`.
5. Run `pnpm typecheck`. A `.collection.json` still naming an old key fails `next build` with `Schema reference "postSchema" ... not found in registry. Available schemas: ...`; in the editor, that entry type shows as unavailable.

Content files, frontmatter and `.canopy-meta/` caches are untouched; in dev, editing a `.collection.json` invalidates the schema cache.

**Now deletable.** A hand-written interface of `TypeFromEntrySchema<typeof xSchema>` members that existed only to type `buildContentTree`'s second generic.
