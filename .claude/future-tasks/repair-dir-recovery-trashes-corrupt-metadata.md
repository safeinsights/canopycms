---
priority: P3
adopters: BOTH
summary: >-
  The worker's leftover sweep (`recoverRepairDir`, branch-provisioning.ts) restores a `.repair-*` directory to its branch name only when its `branch.json` loads. One whose `branch.json` is corrupt (unparseable, or failing the read-boundary schema) is renamed to `.trash-*` instead, so a live branch caught mid-quarantine with damaged metadata leaves the branches list and System health rather than appearing as a repairable corrupt-metadata row
---
# A `.repair-*` with corrupt `branch.json` is trashed, not restored for repair

## Priority: P3 [BOTH]

`recoverRepairDir` (`branch-provisioning.ts`) handles a `.repair-*` directory left by a process
killed mid-quarantine. It reads the branch name from `branch.json` with
`readBranchMetadataFile(...).catch(() => null)`, so any `BranchMetadataCorruptError` reads as "no
metadata" and the directory goes to `.trash-*`.

The read-boundary schema (`branch-metadata-file.ts`) widens that path. A file that parses but lacks
`status` or `access` used to restore under its recorded name. It is now corrupt, so it is trashed too.

Trash is a rename and the worker keeps it for 30 days, so nothing is deleted. But the branch drops
out of System health, where repair-metadata could have fixed it. An admin has to know to look in
`.trash-*`.

## Fix

Two options, one per class of corrupt file:

- The corrupt file still names its branch. Read the name leniently: `branch.name` alone, from the
  raw JSON. If it matches the `.repair-*` prefix, restore the directory under that name, where
  branch-health classifies it as corrupt-metadata.
- The JSON does not parse at all. Keep trashing the directory, but log it at error level, naming the
  trash directory.

## Related

- [resolved/branch-metadata-no-schema-validation.md](resolved/branch-metadata-no-schema-validation.md)
