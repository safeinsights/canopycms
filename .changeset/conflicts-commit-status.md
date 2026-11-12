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
Make it a required check in branch protection to stop a by-hand merge of undecided content.
`init-github-app` now asks for the "Commit statuses: read and write" permission, and `verify`
reports an installation without it. Until an installation has it, only the status is refused, and
System health says so.

**To adopt.** On a GitHub App, an owner of the account it is installed on accepts the new
permission request in the installation's settings, then runs `canopycms init-github-app verify`.
A fine-grained token needs "Commit statuses: read and write"; a classic token's `repo` scope
already covers it. See [Submitting for Review](../README.md#submitting-for-review).
