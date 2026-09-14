import { afterAll, beforeAll, expect } from 'vitest'

import { listTmpdirCdkOutEntries } from './test-synth'

/**
 * Fails any test file that leaks a CDK cloud assembly into `os.tmpdir()`.
 *
 * Registered as a `setupFiles` entry, so it wraps EVERY test file in this
 * package rather than only the one that asserts on it directly, and that
 * breadth is the point: `test-synth.test.ts` asserts the same property, but only
 * around a single synth it performs itself.
 *
 * A textual scan for a bare `App` construction cannot close this class - the
 * namespace-qualified form, a scope-less `Stack` (whose constructor builds its
 * own `outdir`-less App) and a `Stack` subclass all slip past one, and the shape
 * no regex can reach is an ordinary helper like
 * `function makeStack(app?: App) { return new Stack(app, ...) }`, textually
 * clean and leaking only when the argument is omitted. This hook asks the
 * question a scan only approximates: did a synth land somewhere we do not own,
 * by any route and any spelling?
 *
 * Scoped per file rather than per test, so the cost is two `readdir`s per file
 * and a failure names the file that leaked.
 *
 * Accepted false-positive: another process creating a `cdk.out*` entry in the
 * same tmpdir during the file's run. Only an App constructed with no `outdir`
 * does that, so in practice it means another checkout running an unfixed suite.
 * Transient, and the set difference keeps an unrelated process's entry from
 * being attributed to us.
 */
let entriesBeforeFile: Set<string>

beforeAll(() => {
  entriesBeforeFile = listTmpdirCdkOutEntries()
})

afterAll(() => {
  const added = [...listTmpdirCdkOutEntries()].filter((entry) => !entriesBeforeFile.has(entry))
  expect(added).toEqual([])
})
