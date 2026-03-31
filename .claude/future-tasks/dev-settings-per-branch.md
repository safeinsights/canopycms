# Future Task: Per-Branch Settings Isolation in Dev Mode

## Problem

Currently, dev-mode settings (groups, permissions) are deployment-scoped: one shared
settings branch (`canopycms-settings-local`) used by all content branches. This mirrors
prod behavior, where settings are shared across all content branches within a deployment.

However, in local development there is a distinction between:

- **Content branches** (created by CMS editors within one deployment)
- **Developer git branches** (created by developers for bug fixes, features, etc.)

A developer on `feature/new-permissions` may want test settings that differ from a
developer on `fix/auth-bug`. Since `.canopy-dev/` persists across git branch switches,
settings from one development line can leak into another.

## Design Questions

1. **Should dev settings be isolated per developer git branch?**
   - This would mean `git checkout feature-x` gives you `feature-x`'s test settings.
   - Requires changes to `getSettingsBranchName()` and `getSettingsRoot()` in `DevStrategy`.

2. **How to handle the settings workspace directory?**
   - Option A: One settings workspace per git branch (`.canopy-dev/settings-{branch}/`)
   - Option B: Single workspace directory, switch the checked-out settings branch on startup

3. **Should these settings ever be pushed to GitHub?**
   - Currently: local-only (never pushed by `sync --push`)
   - Per-branch isolation might benefit from persistence if multiple developers share branches

4. **Migration**: Existing `.canopy-dev/settings/` data would need to be handled
   when switching to per-branch settings.

## Files to Modify

- `packages/canopycms/src/operating-mode/client-unsafe-strategy.ts` - `DevStrategy.getSettingsBranchName()`, `getSettingsRoot()`
- `packages/canopycms/src/settings-workspace.ts` - workspace creation logic
- `packages/canopycms/src/services.ts` - settings branch root resolution
- Tests in `__integration__/permissions/` and `__integration__/settings/`
