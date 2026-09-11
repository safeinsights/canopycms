/**
 * Test-output hygiene shared by every workspace package that runs Vitest: spread
 * `quietTestOutput` into the `test` block of the package's `vitest.config.ts`.
 * See DEVELOPING.md#expecting-console-messages for how to satisfy it.
 *
 * No `vitest` import, runtime or type: the repo root does not depend on vitest
 * (each package does), so the few shapes this reads are declared structurally.
 */

/** The fields this reads from the TestCase / TestSuite / TestModule Vitest passes to `onConsoleLog`. */
interface ConsoleLogSource {
  fullName?: string
  relativeModuleId?: string
  module?: { relativeModuleId: string }
}

function describeSource(entity: ConsoleLogSource | undefined): string {
  const file = entity?.module?.relativeModuleId ?? entity?.relativeModuleId
  if (!file) return 'Code outside any test file'
  return entity?.fullName ? `${file} > ${entity.fullName}` : file
}

// Always named, never left to Vitest's default, for two reasons.
//
// With no reporter configured, Vitest 4 picks its `agent` reporter whenever it
// detects an AI coding agent (std-env's `isAgent`: CLAUDECODE, AI_AGENT, ...).
// That reporter drops console output from passing tests, and the guard below
// never fires under it, even with CI set. That is how canopycms-cdk printed ~950
// lines of aws-cdk-lib deprecation warnings on every CI run while an agent
// running the suite locally saw a clean run.
//
// And the default only adds `github-actions` (failing tests as inline PR
// annotations) when nothing is configured, so naming `dot` alone would drop it.
// Its job summary is off: every package would add an identical, unlabeled
// "Vitest Test Report" to the run page.
type ReporterEntry = 'dot' | ['github-actions', { jobSummary: { enabled: boolean } }]
const reporters: ReporterEntry[] = ['dot']
if (process.env.GITHUB_ACTIONS === 'true') {
  reporters.push(['github-actions', { jobSummary: { enabled: false } }])
}

export const quietTestOutput = {
  reporters,

  // Keep the reporter "all dots": a test that writes to the console is almost
  // always leaking expected output that should be swallowed and asserted instead.
  // In CI this fails the run so noise cannot creep back; locally the output passes
  // through, so ad-hoc console.log debugging still works. Output swallowed by a
  // console spy never reaches here -- the spy replaces the console method before
  // Vitest's interceptor sees the call.
  //
  // Vitest reports the throw as an "Unhandled Rejection" rather than a failed
  // test, so the summary can still read "passed" above "Errors 1 error". That is
  // why the message names the test itself.
  onConsoleLog(log: string, type: 'stdout' | 'stderr', entity?: ConsoleLogSource): void {
    if (!process.env.CI) return
    throw new Error(
      `${describeSource(entity)} wrote to ${type} under CI, which clutters the test log:\n\n` +
        `${log}\n\n` +
        `Swallow expected output with a console spy and assert on it -- mockConsole() from ` +
        `canopycms/test-utils (any package), or vi.spyOn(console, <method>) with a no-op ` +
        `mockImplementation -- or delete the stray log. See DEVELOPING.md#expecting-console-messages.`,
    )
  },
}
