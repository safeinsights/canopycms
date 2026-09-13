# [P3] Two lockfile edge cases in `withCanopy`'s tracing-root lookup

Filed 2026-09-12 by PR 3 of the CMS editor image epic ([cms-image-build-epic.md](cms-image-build-epic.md)).
The final code review of that PR found both and rated them LOW, and they were deferred rather than
fixed there. One needs a setup that is already broken for other reasons; the other only happens when
the working directory is not a physical path, as with a Windows junction.

## Why the root matters

`resolveTracingRoot` in `packages/canopycms-next/src/sharp-tracing.ts` mirrors how Next infers the output
file tracing root when none is configured. Getting it wrong fails in one of two directions:

- **Too wide.** An include that Next's root does not contain gets through. Webpack then copies the
  files outside `.next/standalone`, and Turbopack fails the build.
- **Too narrow.** A valid include is refused, and a standalone build warns.

## 1. Next 13 does not look for `bun.lockb`

- **Lockfile lists.** Next 13.5.7's `lib/find-root.ts` looks for `pnpm-lock.yaml`, `package-lock.json`
  and `yarn.lock`. Next 14.2.25 adds `bun.lockb`. `LEGACY_LOCKFILES` uses the 14.2.25 list for both
  versions.
- **Scenario.**
  - The setup: a Bun workspace on Next 13, its only lockfile a `bun.lockb` at the workspace root,
    and no `experimental.outputFileTracingRoot`.
  - The roots: Next 13 uses the app directory, but this lookup returns the workspace.
  - The result: a hoisted libvips include is accepted, and Next copies it outside the standalone
    output without any warning.
- **Why it was deferred.** In that setup every hoisted dependency already falls outside Next 13's
  root. Such an adopter has to set `experimental.outputFileTracingRoot` anyway, and a configured
  root skips inference.
- **Fix.** Choose the lockfile list by Next major: pass the list, or the major, in
  `SharpTracingInput`. Add a test.

## 2. The lockfile walks start from a path that has not been through `realpath`

- **The difference.** Next walks up from the realpath of its project directory.
  `resolveTracingRoot` walks up from `input.projectDir` as given, which `withCanopy` sets to
  `process.cwd()`.
- **When it bites.** Only when the working directory is not a physical path, for example when it
  is reached through a Windows junction. Depending on where the lockfiles sit, the reviewer's
  fixtures showed either failure direction.
- **Not new.** The outermost walk had the same gap before PR 3.
- **Fix.** Realpath `projectDir` before either walk. Keep resolving a configured relative root
  against the working directory, as Next does.
