#!/usr/bin/env tsx
/**
 * `canopy-assets-canary` - the sandbox proving ground for `AssetSupport`
 * (design record: .claude/future-tasks/assets-media-system.md). NOT a real
 * deployment target and NOT a separate package: a small CDK app living inside
 * `canopycms-cdk` so it exercises that package's own source directly
 * (`../../src`), the way a real consumer's CDK app would after installing it.
 *
 * Deploy via the CDK bootstrap exec role, qualifier `canopy` (bootstrap stack
 * `CDKToolkit-canopy`) - the human SSO role cannot create CloudFront
 * distributions/OACs directly. Account/region are hardcoded here ON PURPOSE:
 * this file only ever deploys to the one sandbox canary account, unlike every
 * other construct in this package.
 *
 * Build the transform Lambda's asset first - `AssetSupport` points
 * `lambda.Code.fromAsset()` at a directory that must already exist, and
 * `cdk synth`/`deploy` fails with "Cannot find asset" otherwise. Run the build
 * with NO flags: `pnpm test` leaves a fixture-only `--skip-native` bundle
 * behind, and `AssetSupport` refuses to synth one.
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
  // Ephemeral by design - this stack exists only to be verified and torn down.
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
