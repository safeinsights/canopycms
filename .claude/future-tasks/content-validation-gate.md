# Content validation gate: `compileAndRenderCheck()` + `canopycms validate-content`

## Priority: P1 [KB]

From the 2026-08-13/14 adopter site audits, triaged as part of the
2026-08-14 go-live backlog re-baseline. No existing task file covered this.
Tagged **[KB]** rather than [BOTH]: the documentation site already
paid for this gap once (see below) and deploys first, so it's the more urgent
side even though the capability generalizes to any adopter.

## The KB learned this the hard way

Malformed MDX **compiles fine and explodes at render** — schema validation
and `entry-validator.ts` both pass a body that later throws inside the
rendering pipeline, in production, in front of a reader. The documentation
site was hit by this in a real production incident and responded by writing
its own defense: a standalone script that actually renders each entry's
content and catches what schema validation cannot.

That's exactly the kind of adopter-authored safety net that should be a
package capability instead of a script one site happened to write after
getting burned.

## Proposed solution

- **`compileAndRenderCheck()`** — a package-level function that takes an
  entry's markdown/MDX body, actually compiles and renders it (not just
  parses it), and returns a structured pass/fail with the underlying error —
  porting the logic an adopter had to build for this in its own repo.
- **`canopycms validate-content` CLI command** — walks the content tree (or a
  changed-files subset, for CI use) and runs `compileAndRenderCheck()` over
  every markdown/MDX entry, porting the driver logic from the equivalent
  adopter-side build gate. Should be usable as a CI gate
  (non-zero exit on any failure) and as a pre-publish check.

## Design questions

- Where does this run in the editor's own save/submit flow, if at all? A
  render-time check is more expensive than schema validation and probably
  shouldn't block every keystroke, but could gate submit.
- Scope to markdown/MDX fields only, or generalize to any field with custom
  render logic?
- Should this fold into
  [content-validation gate + content-lifecycle-scenarios.md](content-lifecycle-scenarios.md)'s
  "which automated checks belong on content PRs" open question, rather than
  standing alone?

## Related

- [content-lifecycle-scenarios.md](content-lifecycle-scenarios.md) —
  explicitly asks "which automated checks belong on content PRs —
  accessibility, SEO, link integrity?" This is the same question with a
  concrete, already-proven-necessary answer for MDX render-safety.
- The adopter-side build gate and render-check module this ports from: a
  compile-and-walk check wired ahead of the site build, plus an element-walker
  that stands in for a real render because `react-dom/server` is banned in the
  Next server graph. Ask the documentation site's maintainers for the current
  source.
