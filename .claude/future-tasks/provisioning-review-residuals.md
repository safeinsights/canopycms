# Branch provisioning: smaller residuals from review

## Priority: P3 [BOTH]

Review of the staged, crash-safe provisioning (`branch-provisioning.ts`) found no data-loss or wedge
path. These smaller items were left for later.

1. **Settings publish still waits on the patient init lock.**
   - `settings-workspace.ts` publishes the staged settings clone under `acquireProvisioningLock`
     (about 600 retries).
   - A dead holder's marker stays live for 90 s, so for about 90 s after a kill, every request that
     needs settings waits past the 60 s request budget. It heals once the marker goes stale.
   - The rename only holds the lock for milliseconds, so it could use
     `acquireProvisioningLockWithin`, as branch publish does.
2. **`.sparse-cone.json` is last-write-wins across configs.**
   - During a `contentRoot` change, a still-warm old Lambda container that provisions a branch
     re-records the old cone.
   - The worker then flips every sparse clone back, and forward again after the next new-config
     record.
   - Modified and untracked files survive a cone change, and the worker skips a clone holding an
     unpublished deletion (a cone change would hide it, and re-widening would restore the file;
     `worker/sparse-cone.ts`). But content disappears and reappears for editors until old
     containers drain.
   - Possible fix: stamp the record with the config's build identity and have the worker ignore an
     older one.
3. **A phantom `branch.json` after delete.** This predates the provisioning change.
   - `deleteBranchHandler` renames the branch directory under `withOccFileLock(branch.json)`, but
     that lock `mkdir -p`s its parent (`utils/occ-json-write.ts`).
   - So a `save()` queued on the same lock can recreate `<old>/.canopy-meta/branch.json`, with no
     `.git`, after the rename.
   - `classifyFinalDir` calls that `live`, so a create of the name answers 409 and the worker never
     repairs it. Only admin purge clears it.
   - Fix: make the OCC lock refuse to recreate a missing branch root, or classify "`branch.json`
     but no `.git`" as residue.
4. **The busy message is wrong for one state.** The "try again in a minute" text is also used for
   the `protected` state (`branch.json.corrupt-*`, left by a failed admin repair), which needs an
   admin, not a minute. Give that state its own message.
5. **The idempotent 200 discards a deliberate second create.**
   - The same creator re-POSTing the same name within 5 minutes gets 200 with the existing branch,
     and the editor says "created" without applying the new title, description or access.
   - This is by design for retrying a killed request.
   - If it confuses anyone, compare the request body with the stored metadata and answer 409 when
     they differ.
6. **A first settings init clones once per container.**
   - The settings build runs before any cross-process lock (`settings-workspace.ts`).
   - So on a first boot, or with an interrupted workspace, every Lambda container serving the
     editor's parallel first requests clones the whole repo (settings clones are never sparse)
     into its own `.prov-settings-*`, and only one is published.
   - It heals once any clone finishes, but it multiplies EFS load. A clone killed at the request
     budget leaves staging that is swept only after 20 minutes.
   - Fix: let later arrivals wait briefly on the publish lock and re-check before cloning.
7. **Settings quarantine trusts one look through the path.**
   - Under the init lock, the settings publish reads `settingsRootState` and renames `settings` to
     trash by name.
   - It has none of branch quarantine's move-then-verify-by-inode, so a host with a stale NFS
     dentry for an interrupted clone could trash a workspace another host has just published.
   - The cost is small (an unpushed empty orphan commit, kept 30 days in trash), but it should reuse
     `quarantineResidueAt`'s pattern.
