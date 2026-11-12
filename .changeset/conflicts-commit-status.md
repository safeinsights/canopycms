---
'canopycms': minor
'canopycms-cdk': minor
---

### A "CanopyCMS conflicts" status on pull requests — **new GitHub App permission**

<!-- migration
area: Worker
action: GitHub App owners accept permission
row: PR head shows open conflicts; App needs Commit statuses
-->

**What changed.** The worker sets a `CanopyCMS conflicts` commit status on each pull request's
head: it fails with the number of choices still open in the editor, and passes once none are.
Make it a required check in branch protection to stop a by-hand merge of undecided content, on a
branch the CMS opens every pull request into: other pull requests never get it.
`init-github-app` now asks for the "Commit statuses: read and write" permission, and `verify`
reports an installation without it. Until an installation has it, only the status is refused, and
System health says so.

**To adopt.** On an existing GitHub App, its owner adds "Commit statuses: read and write" in the
App's permissions on GitHub, an owner of the account it is installed on accepts the request in the
installation's settings, then `canopycms init-github-app verify` confirms it. A fine-grained token
needs "Commit statuses: read and write"; a classic token's `repo` scope already covers it. See
[Submitting for Review](../README.md#submitting-for-review).
