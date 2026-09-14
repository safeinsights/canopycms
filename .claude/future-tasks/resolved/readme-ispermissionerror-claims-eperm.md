# README says `isPermissionError` covers EPERM; the code tests EACCES only

**Status:** RESOLVED 2026-09-14 in the final-review fixes PR of
[baseline-quality-202609.md](baseline-quality-202609.md). **Priority: P3.** Found the same day
during the chip A1 comment pass.

`README.md`'s `canopycms/utils/error` sentence said `isNotFoundError` / `isPermissionError` /
`isFileExistsError` classify `ENOENT`, `EACCES`/`EPERM`, `EEXIST`.
`packages/canopycms/src/utils/error.ts` tests `EACCES` only, and the code is the source of
truth, so the README now lists `EACCES` alone.
