# `putMetaIfAbsent` uses `wx`, the one exclusive-create primitive concurrency.md tells us not to use

Found 2026-08-12 while auditing exclusive-create primitives for the Workstream D
force-with-lease verification
([program-d-stack-rebuild.md](program-d-stack-rebuild.md), item 11). Not a bug
report — a deliberate choice that appears to have missed a strictly better
option.

## What it does

`assets/store-local.ts`'s `putMetaIfAbsent` creates the asset meta file with
`fs.writeFile(filePath, JSON.stringify(meta), { flag: 'wx' })`, and its doc
comment explains the intent clearly:

> Atomic-exclusive create: opens with the `wx` flag so two concurrent writers
> racing on the same hash32 have exactly one winner ('created') and exactly one
> loser ('already-exists'). The rename-based `atomicWriteFile` helper is
> deliberately NOT used here — a rename always clobbers the destination, which
> would let the second writer silently overwrite the first instead of losing
> cleanly.

That reasoning is right about `rename`. The gap is that it considers only two
options.

## The gap

[docs/concurrency.md](../../docs/concurrency.md) Layer 2 says, of new-file
creation: use temp + `link()`, and **"never `writeFile({flag:'wx'})`, which can
leave a partial file that breaks every later parse."** `occ-json-write.ts` does
exactly that, and gets *both* properties at once:

- **exclusive create with a clean loser** — `link()` fails with `EEXIST`, same as
  `wx`, so the race semantics `putMetaIfAbsent` needs are preserved; and
- **crash atomicity** — the content is fully written to the temp file before the
  link makes it visible, so a crash mid-write cannot publish a truncated file.

`wx` gives the first but not the second. A crash between `writeFile` opening the
file and completing the write leaves a partial `meta.json`, and `getMeta`'s
`JSON.parse` throws on every subsequent read of that asset — the exact failure
Layer 2's rule exists to prevent. The comment rules out `rename` (correctly) but
never considers `link()`, which has neither drawback.

## Why it is low priority

- It is the **local** asset adapter. Prod uses S3 (`assets/factory.ts` picks by
  `media` config), so the hot path for a real deployment does not go through it.
- The window is small and needs a crash at exactly the wrong moment.

## Why it is worth filing anyway

- An adopter *can* configure the local adapter in prod. On EFS that also puts it
  on NFS, where `wx` (`O_CREAT|O_EXCL`) is the primitive concurrency.md's
  preamble pointedly does **not** list as server-enforced — see item 11 of
  [program-d-stack-rebuild.md](program-d-stack-rebuild.md) for why that
  distinction matters and is not merely pedantic.
- It is a documented invariant contradicted in the letter by production code.
  Anyone grepping `wx` after reading concurrency.md will find this and have to
  re-derive whether it is deliberate. This file is that answer.

## Fix direction

Swap `wx` for the temp + `link()` pattern `occ-json-write.ts` already implements,
keeping the `EEXIST` → `'already-exists'` mapping exactly as it is
(`isFileExistsError` already covers it). If the current behaviour is preferred
for a reason not captured in the comment, record that reason there instead — the
point is that the choice should be explicit about `link()`, not just about
`rename`.
