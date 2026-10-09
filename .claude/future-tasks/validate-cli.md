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

## Related

- [resolved/dangling-reference-build-check.md](resolved/dangling-reference-build-check.md)
