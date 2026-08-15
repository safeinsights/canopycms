# `generateContentSitemap`'s `extraUrls` can emit a non-absolute `<loc>`

**Priority:** P3 — narrow, sitemap-spec correctness issue, not a security bug
**Found:** 2026-08-15, PR #235 human-review fix session (fix/human-review-235), noted by the
reviewer as a "second, unrelated consequence" of the `isAbsoluteUrl`/backslash-spoofing fix in
that same session

## Problem

`generateContentSitemap` (`packages/canopycms-next/src/static.ts`) requires an absolute `siteUrl`
and throws if it isn't (`isAbsoluteUrl(siteUrl)` check, with the comment "a sitemap whose `<loc>`
values aren't absolute URLs is invalid and search engines silently reject the entire file"). But
each `extraUrls[].path` is resolved with the same `resolveSeoUrl(extra.path, urlOpts)` used for
ordinary entries, and `resolveSeoUrl` treats anything `isAbsoluteUrl` calls absolute — including a
LITERAL protocol-relative value like `//cdn.example.com/x` — as a deliberate off-site pointer and
passes it through verbatim, with no `siteUrl` prefix.

A protocol-relative `<loc>` (`//cdn.example.com/x` instead of `https://cdn.example.com/x`) is
exactly the invalidity the function's own `siteUrl` guard exists to prevent, just reachable
through a different field. Nothing catches it: `generateContentSitemap` builds successfully, and
the resulting sitemap silently carries a spec-invalid entry.

## Suggested fix

Either validate each `extraUrls[].path` the same way `siteUrl` is validated (reject or throw on a
protocol-relative value with no declared scheme, since a sitemap `<loc>` must have one), or make
`resolveSeoUrl`'s "absolute, pass through verbatim" branch scheme-qualify a literal `//` value
using the current `siteUrl`'s scheme before emitting it (`//cdn.example.com/x` ->
`https://cdn.example.com/x`) rather than leaving it protocol-relative. The latter is more
forgiving of adopter input; the former matches the existing `siteUrl` guard's fail-loud posture.

Not urgent: this is a genuine adopter misconfiguration (writing a protocol-relative `extraUrls`
path), not attacker-reachable, and a malformed `<loc>` degrades a single entry's search-index
inclusion rather than corrupting the file structurally the way the `siteUrl` case does.
