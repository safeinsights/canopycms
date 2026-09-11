# License scan: UNKNOWN-severity licenses are not gated

**Status:** Open, found 2026-09-11 while landing the license scan itself (PR #313). **Priority: P3.**

## What the gate covers, and what it does not

`.github/workflows/ci.yml`'s `Scan dependency licenses (Trivy)` step runs with
`severity: 'HIGH,CRITICAL'`. Trivy maps a license to a severity through its own
classification of the SPDX expression — `restricted` (LGPL/GPL-class) lands at HIGH,
`reciprocal` at MEDIUM, permissive at LOW. A license Trivy cannot classify at all is
reported at **UNKNOWN**, which `HIGH,CRITICAL` excludes.

The practical hole: a dependency whose `license` field is a custom string rather than an
SPDX identifier is invisible to the gate, whatever its actual terms. The production graph
already contains one — `@codesandbox/nodebox`, whose license reads
`SEE LICENSE IN ./LICENSE`. Nothing about that string tells Trivy (or the gate) whether the
terms are permissive or GPL.

So the check as landed gates *recognisably* restricted licenses. It does not gate
*unrecognisable* ones, and the second set is where a deliberately mislabelled package would
sit.

## Why it was not fixed in PR #313

Adding `UNKNOWN` to the severity list reds CI immediately on `@codesandbox/nodebox`, which
would have violated the one constraint that PR was built around: do not land something that
reds CI on arrival. Fixing it properly means first deciding what to do about nodebox —
read its bundled LICENSE, satisfy yourself about the terms, and then either exempt it by
package name in `.trivy-ignore-policy.rego` (the same mechanism the libvips exemption uses,
so the cost is one rule) or replace the dependency.

That is a judgement call about a real license, not a mechanical change, which is why it is
a separate task rather than a follow-up commit.

## Shape of the fix

1. Read `node_modules/.pnpm/@codesandbox+nodebox@*/node_modules/@codesandbox/nodebox/LICENSE`
   and record what it actually says.
2. Add a package-scoped exemption to [.trivy-ignore-policy.rego](../../.trivy-ignore-policy.rego)
   with that finding written into the comment, following the libvips rule's shape.
3. Add `UNKNOWN` to the step's `severity` list in `.github/workflows/ci.yml`.
4. Verify red-before-green: the scan must fail with the exemption removed and pass with it,
   the same way the libvips rule was verified.

## Related

- `lint-warnings-not-enforced.md` — the sibling gap on the ESLint side, tracked on PR #306 and
  not yet on main, so it is named here rather than linked. `security/detect-bidi-characters` is
  a warning that cannot fail CI, which is part of why PR #313 added a separate whole-tree bidi
  step. Link it from here once #306 lands.
