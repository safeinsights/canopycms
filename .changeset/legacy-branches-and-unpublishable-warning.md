---
'canopycms': minor
'canopycms-cdk': minor
---

### `legacyBranches` keeps branches from outside the namespace publishing, and System health names any that cannot — **template first**

<!-- migration
area: CDK
action: Template first, set legacyBranches
row: List open branches outside the namespace in legacyBranches
-->

**What changed.** `CanopyCmsService` takes `legacyBranches`: exact names of branches outside
[the gateway's namespace](./gateway-branch-namespace.md) that editors are still working on, which
the GitHub gateway may still write. It writes them, comma-separated, to the gateway's
`CANOPYCMS_LEGACY_BRANCHES`, and refuses at synth any list the gateway would refuse at boot,
such as an entry holding `*` or a comma, inside the resolved namespace, a branch the namespace
sits under, or repeated. Each git sync, the worker checks every editor branch against the
gateway's policy, and System health lists by full name the ones it would refuse to publish, with
what to do. The gateway now returns a pull request's body only when its head is in the
namespace, not protected and in this repository; for any other pull request it returns the merge
state alone. So a legacy branch's pull request shows its comments and review state as of its
last submit, rather than following each change.

**To adopt.** Before deploying, open the editor's branch list and pass every open branch whose
name is outside the namespace as `legacyBranches`; a hand install sets `CANOPYCMS_LEGACY_BRANCHES`
in `gateway.env` instead. After the deploy, System health names any you missed. Remove an entry
once its branch is merged or deleted.
