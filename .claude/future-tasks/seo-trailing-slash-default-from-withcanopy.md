# Default the sitemap/metadata `trailingSlash` from `withCanopy`

## Priority: P3 [BOTH]

Filed 2026-10-04 while fixing the editor API's trailing-slash redirects.

## The gap

`generateContentSitemap` and `entryToMetadata` (`canopycms-next/src/static.ts`) take
`trailingSlash` as an explicit option, and README.md tells adopters to "set `trailingSlash` to
match your `next.config` — CanopyCMS cannot read that file". An adopter who forgets ships a
sitemap and canonical tags that all 308 on a `trailingSlash: true` site.

`withCanopy` now reads `nextConfig.trailingSlash` and, when it is true, sets
`env.CANOPY_API_TRAILING_SLASH`, which Next inlines into server and browser bundles (measured in
a real `next build` of `apps/example1`, webpack and Turbopack; output quoted in PR #366). The API client reads it through
`readApiTrailingSlashEnv()` in `packages/canopycms/src/api/request-url.ts`.

## Proposed solution

- Let both helpers default `trailingSlash` to `readApiTrailingSlashEnv()` when the option is
  omitted, keeping an explicit value authoritative. If the env key then serves more than the API,
  rename it (e.g. `CANOPY_TRAILING_SLASH`) in `with-canopy.ts`, `request-url.ts` and their tests.
- Update the README sentence once it is no longer true.
- Check that the sitemap route (`app/sitemap.ts`) is bundled code where Next's `env` substitution
  applies, not a file read from outside the bundle.

## Related

- [trailing-slash-router-helpers.md](trailing-slash-router-helpers.md): site links, the third
  surface with the same rule.
