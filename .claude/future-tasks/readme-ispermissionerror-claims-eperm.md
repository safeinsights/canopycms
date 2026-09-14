# README says `isPermissionError` covers EPERM; the code tests EACCES only

**Status:** Open. **Priority: P3.** Found 2026-09-14 during the chip A1 comment pass in
[baseline-quality-202609.md](resolved/baseline-quality-202609.md).

`README.md` (the `canopycms/utils/error` section, around line 2136) says
`isNotFoundError` / `isPermissionError` / `isFileExistsError` classify `ENOENT`,
`EACCES`/`EPERM`, `EEXIST`. `packages/canopycms/src/utils/error.ts` tests `EACCES` only, and
its one-line doc now says so. Either the README drops `EPERM` or the predicate grows to cover
it; the code is the source of truth today. Chip D of the same epic is consolidating README
and may resolve this in passing; if it does, move this file to `resolved/`.
