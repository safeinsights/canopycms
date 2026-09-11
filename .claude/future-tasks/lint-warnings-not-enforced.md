# [P3] Only `lint:scripts` fails on eslint warnings, so warnings accumulate silently everywhere else

Found 2026-09-09 during review of PR #305, where a new file added two
`security/detect-unsafe-regex` warnings and **nothing failed**. The package's
lint went from 0 problems to 2 and still exited 0. Caught by a reviewer reading
lint output, not by any check.

## The gap, as measured

```
$ # root scripts
lint            warnings allowed
lint:fix        warnings allowed
lint:bundle     warnings allowed
lint:cycles     warnings allowed
lint:tasks      warnings allowed
lint:docs       warnings allowed
lint:actions    warnings allowed
lint:scripts    ENFORCED   (--max-warnings 0)

$ # per-package lint scripts
canopycms              warnings allowed
canopycms-next         warnings allowed
canopycms-cdk          warnings allowed
canopycms-auth-clerk   warnings allowed
canopycms-auth-dev     warnings allowed
```

`scripts/` is the only tree in the repo where an eslint warning fails a build.
Everywhere else — including all five published packages — a warning is
invisible to CI.

## Why now is the cheap moment

**The repo is currently at zero warnings** (`pnpm lint` over all five packages,
2026-09-09: no warning lines, no `problems` summary). So adding
`--max-warnings 0` to the five package `lint` scripts is a **no-op today** that
locks in the clean state. Every day it is deferred, the odds rise that it stops
being free and turns into a cleanup task first.

Verify before changing anything, since this claim decays:

```
pnpm lint 2>&1 | grep -c " warning "
```

## Scope

Add `--max-warnings 0` to the `lint` script in each of the five
`packages/*/package.json`. Deliberately NOT the root aggregate scripts:
`lint` is `pnpm -r run lint` and inherits enforcement from the packages, and
`lint:bundle`/`lint:cycles`/`lint:tasks`/`lint:docs`/`lint:actions` are not
eslint at all (dependency-cruiser and node scripts), so the flag is meaningless
there.

Worth deciding as part of this: whether the repo's convention is
"warnings are errors" or "warnings are advisory". If advisory, this task should
be closed as won't-fix rather than left open — but then the 8 existing
`eslint-disable` comments carrying written justifications (7 in packages, plus
`security/detect-unsafe-regex` sites) are doing work the tooling does not
require, which is its own inconsistency worth resolving in one direction.
