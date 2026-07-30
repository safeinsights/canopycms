/**
 * Example CDK stack for deploying CanopyCMS to AWS.
 *
 * This shows how an adopter would use the canopycms-cdk constructs
 * in their own CDK infrastructure code.
 *
 * Usage:
 *   cdk deploy CmsStack
 */

import { Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { CanopyCmsService, CanopyCmsDistribution } from 'canopycms-cdk'

interface CmsStackProps extends StackProps {
  /** Domain for the CMS (e.g., 'cms.docs.example.org') */
  domainName: string
  /** Route53 hosted zone domain (e.g., 'example.org') */
  hostedZoneDomain: string
  /** Clerk JWT public key for networkless verification */
  clerkJwtKey: string
  /** Bootstrap admin Clerk user IDs (comma-separated) */
  bootstrapAdminIds: string
  /**
   * Namespaces this deployment's settings branch
   * (`canopycms-settings-{deploymentName}`). Two stacks pointed at the SAME
   * GitHub repo MUST use different values, or both resolve
   * `canopycms-settings-prod` and fight over it. Changing it later on a stack
   * that already has a populated settings workspace is refused at boot.
   */
  deploymentName: string
}

export class CmsStack extends Stack {
  constructor(scope: Construct, id: string, props: CmsStackProps) {
    super(scope, id, props)

    // Reference existing secrets (create manually or in a separate stack)
    const githubToken = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GitHubToken',
      'canopycms/github-token',
    )
    const clerkSecretKey = secretsmanager.Secret.fromSecretNameV2(
      this,
      'ClerkSecret',
      'canopycms/clerk-secret-key',
    )

    // Core CMS infrastructure: VPC + EFS + Lambda + EC2 Worker
    const cmsService = new CanopyCmsService(this, 'CmsService', {
      // Docker image built from the adopter's app. `cdk deploy` builds this
      // and publishes it to the CDK assets repository -- it is the ONLY thing
      // that ships CMS code. Do not pair it with a separate ECR push +
      // `aws lambda update-function-code`; that leaves the function's image
      // URI out of sync with CloudFormation, and the next `cdk deploy`
      // silently reverts the code. See .github/workflows/deploy-cms.yml.
      cmsDockerImage: lambda.DockerImageCode.fromImageAsset('.', {
        file: 'Dockerfile.cms',
        // Dockerfile.cms declares this as an ARG and Next.js inlines it into
        // the CLIENT bundle at build time, so it has to be supplied to the
        // image BUILD -- a Lambda environment variable would be far too late.
        // CDK builds the image, so it must come through buildArgs here, not
        // through a `docker build --build-arg` step in CI.
        buildArgs: {
          NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '',
        },
      }),

      // Worker configuration
      githubOwner: 'your-org',
      githubRepo: 'your-docs-site',

      // See CmsStackProps.deploymentName -- distinct per stack when several
      // share one GitHub repo.
      deploymentName: props.deploymentName,

      // Secrets the EC2 worker needs to read
      secretsArns: [githubToken.secretArn, clerkSecretKey.secretArn],
      githubTokenSecretArn: githubToken.secretArn,
      clerkSecretKeySecretArn: clerkSecretKey.secretArn,

      // Lambda environment (no secrets here — only public config)
      environment: {
        CANOPY_AUTH_MODE: 'clerk',
        CLERK_JWT_KEY: props.clerkJwtKey,
        CANOPY_BOOTSTRAP_ADMIN_IDS: props.bootstrapAdminIds,
      },

      // Optional tuning
      memorySize: 2048,
      reservedConcurrency: 10,
    })

    // Optional: CloudFront distribution + DNS
    // Skip this if you have your own CloudFront setup — just use cmsService.functionUrl
    new CanopyCmsDistribution(this, 'CmsDist', {
      functionUrl: cmsService.functionUrl,
      domainName: props.domainName,
      hostedZoneDomain: props.hostedZoneDomain,
    })
  }
}

// ============================================================================
// Example app entry point (bin/app.ts)
// ============================================================================
//
// import { App } from 'aws-cdk-lib'
// import { CmsStack } from '../lib/cms-stack'
//
// const app = new App()
//
// // Testing CMS
// new CmsStack(app, 'CmsTest', {
//   env: { account: '111111111111', region: 'us-east-1' },
//   domainName: 'cms.docs.sandbox.example.org',
//   hostedZoneDomain: 'sandbox.example.org',
//   clerkJwtKey: process.env.CLERK_JWT_KEY!,
//   bootstrapAdminIds: 'user_abc123',
//   deploymentName: 'testing',
// })
//
// // Production CMS
// new CmsStack(app, 'CmsProd', {
//   env: { account: '222222222222', region: 'us-east-1' },
//   domainName: 'cms.docs.example.org',
//   hostedZoneDomain: 'example.org',
//   clerkJwtKey: process.env.CLERK_JWT_KEY!,
//   bootstrapAdminIds: 'user_abc123,user_def456',
//   deploymentName: 'prod',
// })
