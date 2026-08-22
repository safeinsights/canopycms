# ARCHITECTURE.md lists a `canopycms/config` entrypoint that does not exist

Found 2026-08-20 while resolving
[canopycms-test-utils-export-unbuilt.md](resolved/canopycms-test-utils-export-unbuilt.md)
— it is the paragraph directly above the one that fix rewrote, so it was read closely by
accident rather than by design.

## What's wrong

ARCHITECTURE.md's "Package Architecture" section says of the core package:

> It exposes multiple entrypoints: `canopycms/server` ..., `canopycms/client` ...,
> `canopycms/config` (configuration helpers), `canopycms/ai` ..., and `canopycms/build` ...

`canopycms` has no `./config` subpath. Its `exports` map is `.`, `./client`, `./server`,
`./auth`, `./auth/cache`, `./http`, `./task-queue`, `./worker/task-queue`,
`./worker/cms-worker`, `./ai`, `./build`, `./utils/error`, `./test-utils`. Verified:

```
node -e "console.log(Object.keys(require('./packages/canopycms/package.json').exports).includes('./config'))"
# false
```

`canopycms-next` **does** have a `./config` subpath, which is the likely source of the
confusion.

## What to do

Low-stakes, but it is the kind of claim an adopter acts on and then files a bug about. Work
out where config helpers actually come from (the root `canopycms` entry is the likely answer)
and correct the sentence — the same list also omits several subpaths that do exist
(`./auth`, `./http`, `./task-queue`, `./worker/*`, `./utils/error`), so it is worth
regenerating the list from the exports map rather than patching one word.

While there, check whether README.md and CODEBASE_GUIDE.md repeat the same claim.
