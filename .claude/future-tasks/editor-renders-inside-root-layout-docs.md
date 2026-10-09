# The docs never say the editor renders inside the adopter's root layout

**Priority:** P3 [BOTH]. **Found:** 2026-10-05, marketing-site request 66 (measured on a deployed
tier).

## Problem

The editor route mounts under the adopter's root layout, so site chrome, analytics, consent banners
and global fetches there also run in `/edit`. On a tier behind HTTP Basic this raised password
prompts from images the editor never needed. README and `docs/deploying-to-aws.md` explain where a
Clerk provider goes relative to the root layout, but not this.

## Proposal

A short adopter-guide note: keep site chrome and global side effects out of the editor route (a
route group for the public site, or a path check). Optionally export an `isEditorPath(pathname)`
helper that respects `basePath` and the editor route; that is a new export, so it needs JP's
approval.
