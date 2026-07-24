# FIXES.md — older catch-all list (triaged 2026-07-24)

Triage note: most items here are done or superseded by dedicated task files.
Remaining live items are marked OPEN below; everything else is annotated.

## Small fixes / open questions

- [x] Lambda-friendly initialization: cache services in memory outside of request
      handler — DONE: the Next adapter creates services once at module init
      (`canopycms-next/src/context-wrapper.ts` "Create services ONCE at
      initialization"), which persists across warm Lambda invocations.
- [ ] OPEN: After you publish a branch, you can still save. Should editing be locked
      so reviewers see stable content? Also can't republish currently. (Workflow
      decision; related to the post-merge lifecycle work in
      [post-merge-sync-gaps.md](resolved/post-merge-sync-gaps.md).)

## Bigger items not listed in master plan

- [ ] SEO (meta tags, sitemap, robots.txt) — SUPERSEDED by
      [static-export-sitemap.md](static-export-sitemap.md) and
      [static-export-seo-metadata.md](static-export-seo-metadata.md).
- [ ] GitHub build/deploy (to environment based on branch) — largely covered by the
      deployment-test epic's CLI templates (`deploy-cms.yml.template`) and the
      docs-site infra; remaining CI-shape work tracked in
      [dual-build-ci.md](dual-build-ci.md).
- [ ] OPEN (unowned): PR workflows — accessibility checks? SEO check? Image
      shrinking? (Image shrinking is now moot: on-demand transform layer shipped
      with the assets epic.)
- [x] Assets — SUPERSEDED/DONE: the assets/media epic (PR #126, design record
      [resolved/assets-media-system.md](resolved/assets-media-system.md)) shipped
      content-addressed S3 storage, presigned upload, transform CDN, and editor
      media UX. The sketch at the bottom of this file described branch-scoped
      collection-attached assets; the shipped design deliberately went
      branch-agnostic + content-addressed instead.
- [ ] OPEN (planning): think through editorial + development scenarios
      (dev/staging/prod flow, schema changes vs content branches, long- vs
      short-lived branches, synchronization). Partially overlaps
      [post-merge-sync-gaps.md](resolved/post-merge-sync-gaps.md) (RESOLVED); the
      broader scenario-planning exercise remains unowned.
