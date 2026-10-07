# Paths derived from a branch name can exceed NAME_MAX

## Priority: P3 [BOTH]

Branch names may be up to 250 characters (`paths/validation.ts`). Several on-disk names add to the
sanitized directory name without truncating it:

| Derived name | Extra characters |
| --- | --- |
| `.<dir>.init.lock` (the provisioning lock, `utils/provisioning-lock.ts`) | 11 |
| the admin purge's `.trash-<dir>-<STAMP>` | 24 |
| other `.<dir>` markers | varies |

For a name of roughly 245 characters or more, these exceed the 255-byte NAME_MAX of ext4, APFS and
EFS, so lock acquisition or a purge fails with ENAMETOOLONG.

The provisioning staging, `.repair-*`, `.deleting-*` and `.trash-*` names that
`branch-provisioning.ts` builds are already bounded (the first 40 characters plus a sha1 suffix).

Fix: either cap branch names at about 200 characters in validation, or route every derived name
through the same bounded builder.
