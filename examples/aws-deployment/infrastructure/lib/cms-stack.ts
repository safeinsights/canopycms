/**
 * CanopyCMS infrastructure: VPC + EFS + CMS Lambda + EC2 worker, and
 * optionally CloudFront + Route53 in front of the Lambda's Function URL.
 *
 * This file is yours to edit -- `canopycms init-deploy aws` will not overwrite
 * it without `--force`. The comments below mark the settings that have a
 * silent-failure mode; the rest is ordinary CDK.
 *
 * See docs/deploying-to-aws.md for the full walkthrough, including the media
 * (AssetSupport) and multi-deployment cases.
 */

import { Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { Platform } from 'aws-cdk-lib/aws-ecr-assets'
import { CanopyCmsService, CanopyCmsDistribution } from 'canopycms-cdk'

export interface CmsStackProps extends StackProps {
  /** GitHub repository the EC2 worker pushes branches and opens PRs against. */
  githubOwner: string
  githubRepo: string
  /** FULL Secrets Manager ARN, including the random six-character suffix. */
  githubTokenSecretArn: string
  /** FULL Secrets Manager ARN, including the random six-character suffix. */
  clerkSecretKeySecretArn: string
  /** Clerk's public JWKS PEM, for networkless session verification. */
  clerkJwtKey: string
  /** Clerk publishable key, baked into the client bundle at image-build time. */
  clerkPublishableKey: string
  /** Comma-separated Clerk user IDs granted admin on first boot. */
  bootstrapAdminIds: string
  /** Namespaces this deployment's settings branch (`canopycms-settings-{name}`). */
  deploymentName: string
  /** Optional CloudFront domain, e.g. 'cms.docs.example.org'. */
  domainName?: string
  /** Optional Route53 hosted zone domain, e.g. 'example.org'. */
  hostedZoneDomain?: string
}

export class CmsStack extends Stack {
  constructor(scope: Construct, id: string, props: CmsStackProps) {
    super(scope, id, props)

    // fromSecretCompleteArn, NOT fromSecretNameV2: `secretsArns` below is
    // written verbatim into the worker's IAM policy, so a partial or
    // name-based ARN never matches the real secret and the worker fails with
    // AccessDenied at boot rather than at deploy.
    const githubToken = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'GitHubToken',
      props.githubTokenSecretArn,
    )
    const clerkSecretKey = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ClerkSecret',
      props.clerkSecretKeySecretArn,
    )

    const cmsService = new CanopyCmsService(this, 'CmsService', {
      // `cdk deploy` builds this image and publishes it to the CDK bootstrap
      // assets repository -- it is the ONLY thing that ships CMS code. Do not
      // pair it with a separate ECR push plus `aws lambda
      // update-function-code`: that builds the image twice and leaves the
      // function's image URI out of sync with CloudFormation, so the next
      // `cdk deploy` touching the function silently reverts your code.
      cmsDockerImage: lambda.DockerImageCode.fromImageAsset('.', {
        file: 'Dockerfile.cms',
        // The image platform and the Lambda architecture must agree, or the
        // function fails at invoke with an exec-format error. Building on
        // Apple Silicon defaults to arm64, so arm64 is the pairing that works
        // both locally and on an x86 CI runner.
        platform: Platform.LINUX_ARM64,
        // Next.js inlines NEXT_PUBLIC_* into the CLIENT bundle during
        // `next build`, so this has to reach the image BUILD. A Lambda
        // environment variable would be far too late.
        buildArgs: {
          NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: props.clerkPublishableKey,
        },
      }),
      architecture: lambda.Architecture.ARM_64,

      githubOwner: props.githubOwner,
      githubRepo: props.githubRepo,
      deploymentName: props.deploymentName,

      // Secrets the EC2 worker reads. The Lambda needs none of them.
      secretsArns: [githubToken.secretArn, clerkSecretKey.secretArn],
      githubTokenSecretArn: githubToken.secretArn,
      clerkSecretKeySecretArn: clerkSecretKey.secretArn,

      // Lambda environment: public config only, never secrets.
      environment: {
        CANOPY_AUTH_MODE: 'clerk',
        CLERK_JWT_KEY: props.clerkJwtKey,
        CANOPY_BOOTSTRAP_ADMIN_IDS: props.bootstrapAdminIds,
      },

      memorySize: 2048,
      reservedConcurrency: 10,
    })

    // Media support (uploads, on-demand image transforms). To enable it:
    //
    //   1. add `AssetSupport` to the `canopycms-cdk` import at the top;
    //   2. uncomment the block below, moving it ABOVE `cmsService` (it has to
    //      exist before you can pass its bucket);
    //   3. pass `assetBucket: assetSupport.bucket` to CanopyCmsService;
    //   4. pass the behaviors to CanopyCmsDistribution, `/assets/t/*` FIRST
    //      (CloudFront matches in order, so the general pattern would
    //      otherwise swallow the transform one):
    //
    //        additionalBehaviors: {
    //          '/assets/t/*': assetSupport.assetBehaviors().assetsTransform,
    //          '/assets/*': assetSupport.assetBehaviors().assets,
    //        },
    //
    // `editorOrigins` is REQUIRED: it is the S3 CORS allowlist for the
    // editor's presigned uploads, so it must list the origin the editor is
    // served from.
    //
    // Run `pnpm --filter canopycms-cdk run build:lambda` before deploying --
    // the transform Lambda needs its native sharp binary, and the construct
    // refuses to synth without it.
    //
    // See the assets section of docs/deploying-to-aws.md.
    //
    // const assetSupport = new AssetSupport(this, 'Assets', {
    //   editorOrigins: [`https://${props.domainName}`],
    // })

    // CloudFront + Route53, only when a domain is configured. Skipping this
    // leaves `cmsService.functionUrl` as the entry point, which is enough to
    // exercise the editor and is what keeps a credential-free `cdk synth`
    // working -- HostedZone.fromLookup below needs real AWS context.
    if (props.domainName && props.hostedZoneDomain) {
      new CanopyCmsDistribution(this, 'CmsDist', {
        functionUrl: cmsService.functionUrl,
        domainName: props.domainName,
        hostedZoneDomain: props.hostedZoneDomain,
      })
    }
  }
}
