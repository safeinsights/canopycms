---
'canopycms': minor
'canopycms-cdk': minor
---

### The GitHub gateway writes only its deployment's branch namespace — **security fix, template first**

<!-- migration
area: Worker
action: Template first, list live branches
row: Gateway writes only its namespace, plus a legacy list
-->

**What changed.** The GitHub gateway now pushes, force-pushes, deletes and opens pull requests only
for branches in its branch namespace and the exact names in a new legacy list. The namespace comes
from a template in which `{deployment}` is the deployment name, ending with `/`: by default
`canopycms/{deployment}/`, so `canopycms/prod/` for the default deployment. It is set by
`CanopyCmsService`'s new `branchNamespace` prop (or `CANOPYCMS_BRANCH_NAMESPACE`, then
`branchNamespace` in `canopycms.config.ts`), and the gateway reads it from its own environment
only. Of the settings branches it pushes only this deployment's own, as before with no lease,
deletion or pull request. Before it updates, closes or drafts a pull request by number, it reads
the pull request from GitHub and refuses unless the head is such a branch, in this repository. A
compromised CMS Lambda can no longer drive the gateway at a developer's branch, a deploy branch,
another deployment's branches or settings, or a pull request from outside the namespace. System
health says when the CMS and the gateway resolve different namespaces.

**To adopt.** Deploy the stack template first: the gateway now reads `CANOPYCMS_DEPLOYMENT_NAME`,
`CANOPYCMS_SETTINGS_BRANCH` and `CANOPYCMS_BRANCH_NAMESPACE`, which the template now writes to
`gateway.env` too (a hand install adds them, as `gateway.env.example` shows). The bundle needs
worker contract 3, so the roll gate refuses it on an older template. Stacks sharing a repository
keep `{deployment}` in one template. Then list every branch editors are still working on whose
name is outside the namespace, as [`legacyBranches`](./legacy-branches-and-unpublishable-warning.md)
describes. Until a branch is listed, its publishes, pull request updates and deletion fail
permanently, naming the list.
