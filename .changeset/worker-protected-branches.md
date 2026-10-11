---
'canopycms-cdk': minor
---

<!-- migration
extends: legacy#the-worker-never-pushes-the-base-or-default-branch--security-fix
action: Protect base on GitHub
-->

**What changed.** The worker also protects what the construct's `protectedBranches` prop lists (at
most 1024, no settings branch), never deletes or opens a pull request from a protected or settings
branch, and re-reads GitHub's default branch every 10 minutes.
