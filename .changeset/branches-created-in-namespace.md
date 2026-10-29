---
'canopycms': minor
---

### New branches are created in the branch namespace, and URLs carry their short names — **behaviour change**

<!-- migration
area: Branches
action: Update branch-name CI patterns
row: Editors' branches are created in the branch namespace
-->

**What changed.** A branch an editor creates is named with the deployment's
[branch namespace](./gateway-branch-namespace.md) in front of the typed name, sanitized: typing
`spring/update` creates `canopycms/prod/spring-update` by default. Its short name
(`spring-update`) is what the branch listing returns as `shortName`, what `?branch=` links in pull
request bodies carry, and what a pull request without a title is named after (`Submit
spring-update`); `?branch=` and the API's `/:branch` segment accept it or the full name. A branch
outside the namespace is reached by its full name. Creation refuses a short name that another branch already has (the
base, the active branch, a branch outside the namespace, a name the gateway protects), one equal to
an API route (`admin`, `assets`, …), a name typed with the namespace in front, and any name while
the CMS and the gateway resolve different namespaces or the remote has a branch named after part
of the namespace. The gateway refuses a push into the namespace while GitHub has such a branch.

**To adopt.** Update any CI workflow, ruleset or script that matches the names of branches the
editor creates, for example to skip them with `branches-ignore: ['canopycms/**']`. Branches that
already exist keep their names.
