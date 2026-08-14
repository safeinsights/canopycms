import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
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
  },
})
