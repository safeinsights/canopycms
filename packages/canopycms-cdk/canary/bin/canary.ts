#!/usr/bin/env tsx
/**
 * `canopy-assets-canary` - the sandbox proving ground for `AssetSupport`
 * (PR 7 of the assets/media epic; design record:
 * .claude/future-tasks/assets-media-system.md). NOT a real deployment
 * target and NOT a separate package - it's a small CDK app living inside
 * `canopycms-cdk` so it can exercise that package's own source directly
 * (`../../src`), the same way a real consumer's CDK app would after
 * `npm install canopycms-cdk`.
 *
 * One stack, `canopy-assets-canary`:
 *   - `AssetSupport` in standalone mode (creates its own bucket) with
 *     `editorOrigins: ['http://localhost:3000']` - a dev-mode editor is the
 *     only realistic caller of the canary's presigned-upload CORS.
 *   - A minimal `cloudfront.Distribution` wiring both behaviors
 *     `AssetSupport.assetBehaviors()` returns: the default behavior serves
 *     the S3 origin directly (so an unmatched path just 404s, cheaply -
 *     nothing else is being served by this canary), and `/assets/t/*` is
 *     the origin-group behavior with the transform Lambda as fallback.
 *   - No cert/DNS - default `*.cloudfront.net` domain, `PriceClass_100`.
 *
 * Deploy via the CDK bootstrap exec role, qualifier `canopy` (bootstrap
 * stack `CDKToolkit-canopy` - see the design record's "Sandbox account
 * deploy mechanics" section for why: the human SSO role can't create
 * CloudFront distributions/OACs directly). Account/region are hardcoded
 * here ON PURPOSE - this file only ever deploys to the one sandbox canary
 * account, unlike every other construct in this package.
 *
 * Build the transform Lambda's asset first (`AssetSupport` points
 * `lambda.Code.fromAsset()` at a real directory that must already exist -
 * `cdk synth`/`deploy` will fail with "Cannot find asset" otherwise). Run the
 * build with NO flags: `pnpm test` leaves a fixture-only `--skip-native`
 * bundle behind, and `AssetSupport` refuses to synth one (it requires the
 * `.deployable` marker that only a full build writes).
 *
 *   pnpm --filter canopycms-cdk run build:lambda
 *   cd packages/canopycms-cdk/canary
 *   npx cdk synth
 *   npx cdk deploy --profile sandbox-admin
 */

import { App, RemovalPolicy, Stack, aws_cloudfront as cloudfront } from 'aws-cdk-lib'
import { DefaultStackSynthesizer } from 'aws-cdk-lib'

import { AssetSupport } from '../../src/index'

const CANARY_ACCOUNT = '905418271997'
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
  // Ephemeral by design - this stack exists only to be verified and torn
  // down (see .claude/future-tasks/assets-media-system.md's epic breakdown,
  // PR 7/8).
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
})

const behaviors = assetSupport.assetBehaviors()

new cloudfront.Distribution(stack, 'Distribution', {
  // Default behavior: the plain S3 origin. Any path other than
  // `/assets/t/*` (including `/`) just 404s from S3 - nothing else is
  // served by this canary.
  defaultBehavior: behaviors.assets,
  additionalBehaviors: {
    '/assets/t/*': behaviors.assetsTransform,
  },
  priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
})
