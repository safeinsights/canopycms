import { defineConfig } from 'vitest/config'
import { quietTestOutput } from '../../vitest.shared'

export default defineConfig({
  test: {
    // `dot` reporter + the CI `onConsoleLog` guard, shared with every package.
    ...quietTestOutput,

    env: {
      // Using a deprecated aws-cdk-lib API throws a DeprecationError at the call
      // site instead of printing a warning. A warning is printed on every synth,
      // so one deprecated prop cost ~950 CI log lines a run -- and it prints in
      // adopters' own `cdk synth` too, and the API is slated for removal in v3.
      //
      // Stronger than the console guard, not a duplicate of it: this fails
      // locally as well as in CI, and it reaches scaffold-synth.test.ts's
      // subprocess synth (it spreads process.env), whose stderr the console
      // guard never sees. Migrate the call; do not relax this to `warn`/`quiet`.
      JSII_DEPRECATED: 'fail',
    },

    // CDK synth is genuinely slow -- it builds a full CloudFormation template
    // in-process -- and it got slower with aws-cdk-lib 2.260+. Vitest's 5s
    // default is a generic value, not one tuned for a suite whose unit of work
    // is a synth, and CI runners are materially slower than a dev laptop: a
    // test that took 517ms locally under 2.192 blew the 5s default on CI under
    // 2.265 and failed the run.
    //
    // This is a companion to (not a substitute for) memoizing the default
    // template in cms-deploy.test.ts, which removed 32 of the 33 redundant
    // synths that suite was performing. Raising the ceiling without removing
    // that waste would only have deferred the same failure.
    //
    // Deliberately generous rather than snug: the point is to stop a slow
    // machine from producing a red build that says "timeout" when nothing is
    // actually wrong. A genuine hang still fails, just later.
    testTimeout: 30_000,
    hookTimeout: 30_000,

    // Owns the directory every `App` in this suite synthesizes into, and
    // deletes it when the run ends. Without it each synth strands a cloud
    // assembly in os.tmpdir(): CDK cleans those up from a process exit handler,
    // which a vitest worker never fires. 13 GB across 26,537 orphaned
    // directories, before this was caught. See test-support/test-synth.ts.
    globalSetup: ['./test-support/test-synth.ts'],

    // The behavioral half of the same rule: fails any test file that leaves a
    // cloud assembly in os.tmpdir(), whatever route it took to construct the
    // App. test-synth.test.ts asserts this too, but only around one synth it
    // performs itself; this covers every file.
    setupFiles: ['./test-support/synth-leak-guard.ts'],
  },
})
