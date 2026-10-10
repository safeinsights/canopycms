import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Construct } from 'constructs'
import {
  CfnCondition,
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  Token,
  aws_iam as iam,
  aws_s3 as s3,
  aws_s3_assets as s3assets,
} from 'aws-cdk-lib'

// This package is `"type": "module"`, so `__dirname` is not a global in its
// compiled output. Vitest shims it, so this file's tests would not notice.
// Same fix as ./asset-support.ts.
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * The worker bundle: the single file esbuild writes (`pnpm run build:worker`),
 * shipped to the instance as-is so its sha256 is known at synth. A directory
 * asset would be zipped by cdk-assets at publish time, after synth.
 */
const WORKER_BUNDLE_PATH = path.join(__dirname, '../../worker/dist/index.js')

/** Where user data downloads the bundle to and checks it, before installing it. */
export const WORKER_BUNDLE_DOWNLOAD_PATH = '/tmp/canopy-worker.js'

/** Where `workerCode: { source: 'parameter' }` expects bundles in its bucket: `<prefix><sha256>.js`. */
const WORKER_BUNDLE_KEY_PREFIX = 'canopy-worker/'

function sha256OfFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * Where the worker's bundle comes from.
 *
 * - `'asset'` (default): a CDK asset, so a canopycms upgrade changes the
 *   template and only a template deploy moves the worker.
 * - `'parameter'`: a bucket of bundles keyed by sha256, chosen by a template
 *   parameter, so a parameter-only change set (`--use-previous-template`)
 *   can roll the worker. While the parameter is empty the worker runs the
 *   template's own asset, as in `'asset'` mode. Once set, the parameter
 *   outlives template deploys: `cdk deploy` keeps a parameter's previous
 *   value.
 */
export type WorkerCode = { source: 'asset' } | { source: 'parameter' }

interface WorkerBundleSource {
  /** S3 location and expected sha256, as tokens for user data. */
  readonly bucketName: string
  readonly objectKey: string
  readonly sha256: string
  /** Parameter mode only. */
  readonly bundleBucket?: s3.Bucket
  readonly sha256Parameter?: CfnParameter
}

/**
 * The worker bundle's source, with the worker granted read on exactly what it
 * may download.
 */
export function workerBundleSource(
  scope: Construct,
  workerCode: WorkerCode,
  workerRole: iam.IRole,
): WorkerBundleSource {
  const asset = new s3assets.Asset(scope, 'WorkerCode', { path: WORKER_BUNDLE_PATH })
  const assetSha256 = sha256OfFile(WORKER_BUNDLE_PATH)
  // This one object, not `asset.grantRead`'s whole bootstrap bucket. No KMS
  // grant: the bootstrap bucket's key (aws/s3, or the key bootstrap creates)
  // lets any principal in the account decrypt through S3.
  const readable = [asset.bucket.arnForObjects(asset.s3ObjectKey)]

  if (workerCode.source === 'asset') {
    workerRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: readable }),
    )
    return { bucketName: asset.s3BucketName, objectKey: asset.s3ObjectKey, sha256: assetSha256 }
  }

  const bundleBucket = new s3.Bucket(scope, 'WorkerBundleBucket', {
    versioned: true,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    removalPolicy: RemovalPolicy.RETAIN,
    // Re-uploading a bundle under its own hash leaves a noncurrent version of
    // the same bytes; a launch template only ever names current ones.
    lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
  })
  // A bundle a running or rolled-back launch template names must stay
  // downloadable. Not PutBucketPolicy too: that would lock CloudFormation out
  // of this policy. Emptying the bucket starts by removing this statement.
  bundleBucket.addToResourcePolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: [bundleBucket.arnForObjects('*')],
    }),
  )
  readable.push(bundleBucket.arnForObjects(`${WORKER_BUNDLE_KEY_PREFIX}*`))
  workerRole.addToPrincipalPolicy(
    new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: readable }),
  )

  // One value names the object AND is what it is checked against, so a key
  // and a hash cannot disagree.
  const sha256Parameter = new CfnParameter(scope, 'WorkerBundleSha256', {
    type: 'String',
    default: '',
    allowedPattern: '^([0-9a-f]{64})?$',
    description:
      `sha256 of the CanopyCMS worker bundle to run, uploaded to the worker bundle bucket as ` +
      `${WORKER_BUNDLE_KEY_PREFIX}<sha256>.js. Empty runs the bundle this template was synthesized with.`,
  })
  const fromParameter = new CfnCondition(scope, 'WorkerBundleFromParameter', {
    expression: Fn.conditionNot(Fn.conditionEquals(sha256Parameter.valueAsString, '')),
  })
  const pick = (whenParameter: string, whenAsset: string) =>
    Token.asString(Fn.conditionIf(fromParameter.logicalId, whenParameter, whenAsset))

  new CfnOutput(scope, 'WorkerBundleSha256ParameterName', {
    description: 'The template parameter that selects the worker bundle',
    value: sha256Parameter.logicalId,
  })
  new CfnOutput(scope, 'WorkerBundleBucketName', {
    description: `The bucket holding worker bundles, as ${WORKER_BUNDLE_KEY_PREFIX}<sha256>.js`,
    value: bundleBucket.bucketName,
  })

  return {
    bucketName: pick(bundleBucket.bucketName, asset.s3BucketName),
    objectKey: pick(
      Fn.join('', [WORKER_BUNDLE_KEY_PREFIX, sha256Parameter.valueAsString, '.js']),
      asset.s3ObjectKey,
    ),
    sha256: pick(sha256Parameter.valueAsString, assetSha256),
    bundleBucket,
    sha256Parameter,
  }
}
