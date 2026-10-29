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
for branches in its namespace and the exact names in a new legacy list. The namespace is a template
ending with `/`, where `{deployment}` stands for the deployment name: `canopycms/{deployment}/` by
default, so `canopycms/prod/`. It is set by `CanopyCmsService`'s new `branchNamespace` prop (or
`CANOPYCMS_BRANCH_NAMESPACE`, then `branchNamespace` in `canopycms.config.ts`), and the gateway
reads it from its own environment only. Of the settings branches it pushes only this deployment's
own, as before: no lease, deletion or pull request. It updates, closes or drafts a pull request only
after GitHub shows that its head is such a branch of this repository, so a compromised CMS Lambda
cannot aim it elsewhere. System health says when the CMS and gateway resolve different namespaces.

**To adopt.** Deploy the stack template first: it now writes `CANOPYCMS_DEPLOYMENT_NAME`,
`CANOPYCMS_SETTINGS_BRANCH` and `CANOPYCMS_BRANCH_NAMESPACE`, which the gateway now reads, to
`gateway.env` too (a hand install adds them, as `gateway.env.example` shows). The bundle needs
worker contract 3, which an older template's roll gate refuses. Roll the worker bundle
(`canopycms-cdk`) with or before the CMS image, which creates no branch until the worker reports its
namespace. Stacks sharing a repository keep `{deployment}` in one template. Then list every open
branch outside the namespace, as [`legacyBranches`](./legacy-branches-and-unpublishable-warning.md)
describes. Until listed, a branch's publishes, pull request updates and deletion fail permanently,
naming the list. Rolling the worker back can rename namespace branches so editors cannot open them;
redeploying this release's worker restores their names on its next sync. Submit none meanwhile: a
submit pushes it, without its earlier commits, under its directory name, which this release
publishes only once `legacyBranches` lists it.
