# Local asset store leaves temp files and orphan sidecars after a hard crash

**Status:** Open. **Priority: P3.** Filed 2026-10-07 from review round 1 of
[materialize-release-hardening.md](resolved/materialize-release-hardening.md) PR A.

## State

`LocalAssetStore.createExclusive` (`packages/canopycms/src/assets/store-local.ts`) writes a blob and
its headers to `{root}/.asset-tmp/{uuid}`, links the sidecar into place, then the blob, and unlinks
both temps in a `finally`. A process killed in between leaves:

- temp files in `.asset-tmp/` forever (two per in-flight write; an original can be 50 MiB);
- a `*.headers.json` with no blob. Readers report the key absent, which is correct, but the next
  writer's blob is paired with that orphan's headers, so a static's `Content-Disposition` names the
  first uploader's file.

`link()` also throws `EXDEV` if an adopter mounts a prefix directory (e.g. `{root}/assets`) on a
different filesystem from the root.

## Proposal

On construction or the first write, best-effort remove `.asset-tmp/` entries older than a few
minutes. Optionally fall back to `copyFile` with `COPYFILE_EXCL` on `EXDEV`. Dev and local stores
only; S3 has neither problem.
