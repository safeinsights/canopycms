# Future Task / Kickoff Prompt: Adopter image-field migration

Status: **ready to run** once the assets epic (`epic/assets-media-system`) has merged to
main and a version is published/linked into the adopter apps. Split out of the epic
deliberately (JP 2026-07-22) because it edits the two live adopter repos on their own
schedule. Design context: [assets-media-system.md](assets-media-system.md).

## Why this is separate work

The assets system ships with the structured `image` field accepting existing
root-relative paths as `src`, so it is **serving-neutral** until content is migrated —
adopters can adopt the package version with zero content changes, then migrate when
ready. The website's migration in particular wants to coincide with JP paying attention
to its heavy unoptimized images.

## Kickoff prompt (paste into a fresh session in each adopter repo)

> We've shipped CanopyCMS's assets/media system (structured `image` field
> `{ src, alt, width, height, crop? }`, media library, on-demand `/assets/t/*`
> transforms). This repo currently models images as `type: 'string'` fields holding
> raw `public/` paths (e.g. `imageSrc` + a separate `imageAlt`). Migrate it to the new
> system. Steps:
>
> 1. **Bump** the `canopycms`/`canopycms-next` dependency to the version that includes
>    the assets epic; `pnpm install`; rebuild any consumed `dist`.
> 2. **Schema codemod** (`src/app/schemas.ts`): convert `imageSrc`/`avatarSrc`/
>    `logoSrc`/`creditLogoSrc`-style `{ type: 'string' }` field pairs into a single
>    `{ type: 'image' }` field (fold the paired `*Alt` string into the image value's
>    `alt`; set `aspect` where the layout has a fixed ratio — avatars `1:1`, blog covers
>    `16:9` — and `altOptional: true` only for decorative logos). Enumerate every image
>    field first and show me the mapping before editing.
> 3. **Content codemod** (`content/**`): rewrite each affected entry's string value into
>    the object shape `{ src: <old path>, alt: <old alt>, width, height }`. Read intrinsic
>    dimensions off the real file in `public/` with `image-size` and bake them in (prevents
>    layout shift). Do NOT change the `src` path yet — keep pointing at `public/`; this
>    step is serving-neutral.
> 4. **Component updates**: where components consumed `imageSrc`/`imageAlt` separately,
>    read from the structured value; adopt `assetUrl()`/`assetSrcSet()` from `canopycms`
>    for responsive `srcset` on the larger images.
> 5. **Verify**: `pnpm build` (static export) succeeds; spot-check rendered pages; run the
>    editor (`/edit`) and confirm image fields render the ImageField UI, not "Unsupported
>    field", and that alt-text validation fires.
> 6. **(website only) optimize the offenders**: the 1.5–3.3 MB `public/` images
>    (`contact-platform.jpg` 3.3 MB, `article-hero-data-learning-outcomes.jpg` 2.9 MB, the
>    1.5 MB people PNGs) should move through the asset system so the transform layer serves
>    right-sized webp. This is the step that needs the deployed asset bucket + `media`
>    config — coordinate with the infra wiring (docs-site: see
>    [docs-site-assets-wiring.md](docs-site-assets-wiring.md); website: after its infra
>    port lands).
>
> Project rules: pnpm, no `any`, extensionless imports, run prettier + lint before
> finishing, commit per the repo's conventions. Show me the field mapping (step 2) before
> touching content.

## Notes

- The one epic gate not yet exercised anywhere — **presigned upload from a dev editor
  against a real bucket** — naturally gets covered the first time an adopter with an
  image field uploads through `/edit` in `adapter: 's3'` dev mode.
- Two adopters: `../website` (24 PNG / 19 SVG / 11 JPG, ~14 MB) and `../docs-site-proto`
  (partner logos + MDX figures). Run them as separate sessions.
