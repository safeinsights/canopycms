---
priority: P3
adopters: BOTH
summary: >-
  The content-integrity guards (schema validity, routable slugs, duplicate `urlPath`s, dangling references) run only inside a production build. A `canopycms validate` command would run them against a checkout in seconds, for a pre-commit hook or a CI step that does not build the site
---
# Run the build's content guards without a build

`static/index.ts` runs five guards when `collectStaticPaths`/`collectRoutableEntries` enumerate in
build mode. An adopter who wants them earlier has to build the site, or call the exported
`find*` functions from its own test. A `canopycms validate` CLI command could boot
`createBuildCanopy` from the adopter's config, list every entry once, and run all five, exiting
non-zero on any error.

Open questions: how the CLI loads the adopter's config and entry schema registry (the same problem
as [cli-config-loader-duplication.md](cli-config-loader-duplication.md)), and whether `warn`-level
guards print or fail under a `--strict` flag.

## Same engine for a branch in the editor

Submit validates nothing (`api/branch-status.ts`), and a branch only meets the guards once its PR
builds, so a branch parked across a schema change learns it is broken late. The same guard
functions could back a branch report:

- `GET /:branch/validation`, run in the CMS process (the worker has no field definitions) over an
  unfiltered `listEntries` of the branch workspace, with issues then filtered by the user's read ACL:
  filtering the scan itself makes references to unreadable entries look dangling.
- Add an `entry:` link check, which the build does not run (a missing target ships as `#`).
- A submit gate that blocks only on schema-invalid entries and dangling reference fields, honouring
  `danglingReferences: 'warn'`. Slug and duplicate-URL issues only warn, since a branch-wide scan
  includes data-only collections the build never routes.

Trigger for that part: a schema change breaks a parked branch's build more than once, or an adopter
without CI on content PRs.

## Related

- [resolved/dangling-reference-build-check.md](resolved/dangling-reference-build-check.md)
- [content-lifecycle-scenarios.md](content-lifecycle-scenarios.md)
