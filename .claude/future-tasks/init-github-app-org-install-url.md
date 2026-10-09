# `init-github-app create` prints a user-account install URL for an org-owned App

**Priority:** P3 [BOTH]. **Found:** 2026-10-04, marketing-site request 48; still true at `fecc04a0`.

## Problem

`resolveTarget` detects an organisation and posts the manifest to the org's `settings/apps/new`, but
step 2's printed links are always `https://github.com/settings/apps/<slug>/installations` and
`.../settings/apps/<slug>` (`cli/init-github-app.ts`), which 404 for an org-owned App while the CLI
waits on "Press Enter once it is installed".

## Proposal

Print the owner-agnostic `https://github.com/apps/<slug>/installations/new`, or branch on
`isOrganization` as the manifest URL already does. Test both owner kinds.
