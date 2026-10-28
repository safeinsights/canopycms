---
'canopycms': minor
'canopycms-cdk': minor
---

### The GitHub gateway writes only the `canopycms-` branch namespace — **security fix, template first**

<!-- migration
area: Worker
action: Template first, list live branches
row: Gateway writes only canopycms-* branches, plus a legacy list
-->

**What changed.** The GitHub gateway now pushes, force-pushes, deletes and opens pull requests only
for branches starting `canopycms-` and the exact names in a new legacy list. Of the settings
branches it pushes only this deployment's own, as before with no lease, deletion or pull request.
Before it updates, closes or drafts a pull request by number, it reads the pull request from GitHub
and refuses unless the head is such a branch, in this repository. A compromised CMS Lambda can no
longer drive the gateway at a developer's branch, a deploy branch, another deployment's settings,
or a pull request from outside the namespace.

**To adopt.** Deploy the stack template first: the gateway now reads `CANOPYCMS_DEPLOYMENT_NAME`
and `CANOPYCMS_SETTINGS_BRANCH`, which the template now writes to `gateway.env` too (a hand install
adds them, as `gateway.env.example` shows). The bundle needs worker contract 3, so the roll gate
refuses it on an older template. Then list every branch editors are still working on
whose name does not start with `canopycms-` in `CANOPYCMS_LEGACY_BRANCHES` on the gateway, exact
names separated by commas. Until a branch is listed, its publishes, pull request updates and
deletion fail permanently, naming the list.
