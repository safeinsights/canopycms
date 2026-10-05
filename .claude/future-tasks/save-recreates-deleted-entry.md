# A save carrying a version silently recreates an entry another editor deleted

Found 2026-10-04 while re-verifying
[occ-version-key-contentid-swap.md](resolved/occ-version-key-contentid-swap.md).

## The problem

`ContentStore.write`'s OCC block treats a numeric `expectedVersion` whose target file is
gone (`ENOENT`) as "first write, skip the version check" and writes the file. So if editor
2 deletes an entry while editor 1 has it open, editor 1's next save brings it back with
no conflict and no message. Editor 2's delete is silently undone.

This is not content loss. Editor 1's content is what lands, and a later create of the
same slug 409s rather than overwriting it. But it breaks the rule that a save holding a
version is checked against what is on disk: a missing file is a change since the read.

## Fix direction

On the API path, a numeric `expectedVersion` that finds no file is a 409 ("this entry was
deleted by another editor"), and the editor offers to recreate it explicitly (a create,
`expectedVersion: null`). Check direct `ContentStore.write` callers first; none passes a
numeric version today outside the API.
