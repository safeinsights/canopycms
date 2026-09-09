import { afterAll, beforeAll, expect } from 'vitest'

import { listTmpdirCdkOutEntries } from './test-synth'

/**
 * Fails any test file that leaks a CDK cloud assembly into `os.tmpdir()`.
 *
 * Registered as a `setupFiles` entry, so it wraps EVERY test file in this
 * package rather than only the one that asserts on it directly. That breadth is
 * the point. `test-synth.test.ts` also asserts the property, but only around a
 * single synth it performs itself -- which left the other suites, where all the
 * real synthing happens, covered by nothing but a textual scan for a bare `App`
 * construction.
 *
 * A textual scan cannot close this class, and two review rounds each found
 * another spelling that slipped through it: the namespace-qualified form, a
 * scope-less `Stack` (whose constructor builds its own `outdir`-less App), a
 * `Stack` subclass. The shape no regex can ever reach is an ordinary-looking
 * helper -- `function makeStack(app?: App) { return new Stack(app, ...) }` --
 * which is textually clean and leaks only when the argument is omitted. This
 * hook asks the question the scan was approximating: did a synth land somewhere
 * we do not own? Any route, any spelling.
 *
 * Scoped per file rather than per test so the cost is two `readdir`s per file,
 * and so a failure names the file that leaked.
 *
 * Accepted false-positive: another process creating a `cdk.out*` entry in the
 * same tmpdir during the file's run. Only an App constructed with no `outdir`
 * does that (`determineOutputDirectory` in `@aws-cdk/cloud-assembly-api`'s
 * `cloud-assembly.js` temp-dirs only on the falsy-outdir branch), so in
 * practice that means another checkout still running the pre-fix suite.
 * Transient and self-resolving, and the set difference means an unrelated
 * process's entry can never be attributed to us.
 */
let entriesBeforeFile: Set<string>

beforeAll(() => {
  entriesBeforeFile = listTmpdirCdkOutEntries()
})

afterAll(() => {
  const added = [...listTmpdirCdkOutEntries()].filter((entry) => !entriesBeforeFile.has(entry))
  expect(added).toEqual([])
})
