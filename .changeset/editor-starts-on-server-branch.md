---
'canopycms': minor
---

### The editor opens on the deployment's own default branch — **breaking (client config)**

<!-- migration
area: Branches
action: Readers of client branch fields
row: client() drops defaultBaseBranch and defaultActiveBranch
-->

**What changed.** `/edit` with no `?branch=` now opens on the branch the server names as its
default: `defaultActiveBranch`, else the base branch, as that deployment resolves them. Before,
it opened on the branch the config evaluated in the browser named. In the browser a value read
from an environment variable falls back to its literal, so a deployment whose base differs from
that literal opened on the wrong branch. `config.client()` and `CanopyClientConfig` no longer
carry `defaultBaseBranch` or `defaultActiveBranch`, and `CanopyEditor` without a `branchName`
starts branchless and adopts the server's default, as `CanopyEditorPage` does.

**To adopt.** Nothing, unless your code reads `config.client().defaultBaseBranch` or
`.defaultActiveBranch`. Read the branch from the server config instead (`config.server`, on the
server), or from the branches API's `defaultBranch` in the browser. To open the editor on a
particular branch, link to `/edit?branch=<name>`.

**Now deletable.** A `NEXT_PUBLIC_` copy of the base-branch variable, or an `/edit` link that adds
`?branch=` only to work around the editor opening on the wrong branch.
