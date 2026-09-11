# Trivy ignore policy (OPA rego), passed to the license scan in
# .github/workflows/ci.yml via the trivy-action `ignore-policy:` input.
#
# Why a rego policy rather than the simpler `.trivyignore.yaml`: a YAML
# `licenses: [- id: LGPL-3.0-or-later]` rule matches on the license expression
# ALONE and cannot be narrowed to a package. Neither scoping field helps for
# license findings -- every license finding Trivy emits from this workspace
# carries `FilePath: "pnpm-lock.yaml"` (the lockfile, not the package), so
# `paths:` can only ever match the lockfile, and `purls:` is not applied to
# license findings at all. Verified against Trivy 0.70.0 (the version the
# pinned action installs) and 0.74.0: adding a `paths:` scoped to the sharp
# packages loses the suppression entirely, while a deliberately non-matching
# `purls:` still suppresses.
#
# The consequence is that the YAML form suppressed EVERY LGPL-3.0-or-later
# package in the graph, present and future -- silently passing exactly the kind
# of new restricted dependency this scan exists to catch. Rego receives
# PkgName, so it suppresses precisely what we intend and nothing else.
#
# What is suppressed, and why that is acceptable: libvips, which arrives as the
# prebuilt `@img/sharp-libvips-*` binaries behind `sharp`, a direct production
# dependency backing the on-demand image transform engine in
# packages/canopycms/src/assets/. CanopyCMS does not redistribute libvips --
# the package builds with plain tsc and publishes `files: ["dist"]` with no
# bundledDependencies, so the npm tarball carries only our own MIT JavaScript.
# The adopter's package manager resolves `@img/sharp-libvips-<platform>` into
# the adopter's own node_modules, as a separate, unmodified, dynamically linked
# package that keeps its own license text. We consume the shared library; we do
# not ship it. That is a different posture from the sibling repos that ship
# container images containing the binary and carry a THIRD_PARTY_LICENSES.md.
#
# The prefix match is deliberate: the flagged package name differs by platform
# (`@img/sharp-libvips-darwin-arm64` on a developer's machine,
# `@img/sharp-libvips-linux-x64` AND `-linuxmusl-x64` on CI), while the license
# expression is plain `LGPL-3.0-or-later` in every case.
#
# Any OTHER package carrying a restricted license still fails the build. That
# is the property the YAML form could not provide, and the reason this file
# exists in this shape.
package trivy

default ignore = false

ignore {
	input.Name == "LGPL-3.0-or-later"
	startswith(input.PkgName, "@img/sharp-libvips-")
}
