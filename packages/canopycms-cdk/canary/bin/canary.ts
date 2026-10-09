#!/usr/bin/env tsx
/**
 * `canopy-assets-canary` - the sandbox proving ground for `AssetSupport`
 * (design record: .claude/future-tasks/resolved/assets-media-system.md). NOT a real
 * deployment target and NOT a separate package: a small CDK app living inside
 * `canopycms-cdk` so it exercises that package's own source directly
 * (`../../src`), the way a real consumer's CDK app would after installing it.
 *
 * Deploy via the CDK bootstrap exec role, qualifier `canopy` (bootstrap stack
 * `CDKToolkit-canopy`) - the human SSO role cannot create CloudFront
 * distributions/OACs directly. The account comes from `CANARY_ACCOUNT` and
 * nothing else: pinning `env.account` makes a deploy under the wrong profile
 * fail instead of landing in another account, which a `CDK_DEFAULT_ACCOUNT`
 * fallback (set from whatever profile is active) would defeat.
 *
 * Build the transform Lambda's asset first, with NO flags: `AssetSupport`
 * refuses to synth in lazy mode without the `.deployable` marker a full build
 * writes, and `pnpm test` leaves a marker-less `--skip-native` bundle behind.
 *
 *   pnpm --filter canopycms-cdk run build:lambda
 *   cd packages/canopycms-cdk/canary
 *   CANARY_ACCOUNT=<sandbox account id> npx cdk synth
 *   CANARY_ACCOUNT=<sandbox account id> npx cdk deploy --profile sandbox-admin
 */

import { App, RemovalPolicy, Stack, aws_cloudfront as cloudfront } from 'aws-cdk-lib'
import { DefaultStackSynthesizer } from 'aws-cdk-lib'

import { AssetSupport } from '../../src/index'

const CANARY_ACCOUNT = process.env.CANARY_ACCOUNT
if (!CANARY_ACCOUNT || !/^\d{12}$/.test(CANARY_ACCOUNT)) {
  throw new Error(
    'CANARY_ACCOUNT must be set to the twelve-digit sandbox account id at synth time; ' +
      'the canary takes its account from nothing else.',
  )
}
const CANARY_REGION = 'us-east-1'
const CANARY_QUALIFIER = 'canopy'

const app = new App()

const stack = new Stack(app, 'canopy-assets-canary', {
  env: { account: CANARY_ACCOUNT, region: CANARY_REGION },
  synthesizer: new DefaultStackSynthesizer({ qualifier: CANARY_QUALIFIER }),
  description:
    'CanopyCMS assets epic (PR 7) canary - AssetSupport + transform Lambda verification. Safe to tear down.',
})

const assetSupport = new AssetSupport(stack, 'Assets', {
  editorOrigins: ['http://localhost:3000'],
  // This canary exists to exercise the transform Lambda and its failover.
  lazyPublicTransforms: true,
  // Ephemeral by design - this stack exists only to be verified and torn down.
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
})

const behaviors = assetSupport.assetBehaviors()

new cloudfront.Distribution(stack, 'Distribution', {
  // Default behavior: the plain S3 origin. Any path other than
  // `/assets/t/*` (including `/`) is a 403 from S3 unless the key exists.
  defaultBehavior: behaviors.assets,
  additionalBehaviors: {
    '/assets/t/*': behaviors.assetsTransform,
  },
  priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
})
