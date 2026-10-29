---
'canopycms': minor
---

### New branches are created as `canopycms-<name>` — **behaviour change**

<!-- migration
area: Branches
action: Update branch-name CI patterns
row: Editors' new branches start with canopycms-
-->

**What changed.** A branch an editor creates is named `canopycms-<name>`, whatever was typed:
typing `spring-update` creates `canopycms-spring-update`, and typing a name that already starts
with `canopycms-` keeps it. The branch-name field shows the name it will create. These are the
branches the GitHub gateway writes ([its namespace](./gateway-branch-namespace.md)). A typed name that would become a settings branch name (`settings-…`) is refused, and so is one with no letter or digit, or one the prefix makes longer than 250 characters.

**To adopt.** Update any CI workflow, ruleset or script that matches the names of branches the
editor creates, for example to skip them with `branches-ignore: ['canopycms-*']`. Branches that
already exist keep their names.
