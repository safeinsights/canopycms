/**
 * CDK app entry point -- this is what `cdk.json`'s `app` command runs, and
 * therefore what `cdk deploy` and `cdk synth` build their stacks from.
 *
 * Configuration arrives as environment variables rather than literals so the
 * same file works from a laptop and from CI. `.github/workflows/deploy-cms.yml`
 * passes each of them through from repository secrets and variables -- if you
 * add a `required()` call here, add the matching line there too, or the deploy
 * will fail at synth.
 */

import { App } from 'aws-cdk-lib'
import { CmsStack } from '../lib/cms-stack'

/**
 * Read a variable that the stack cannot be built without.
 *
 * Failing here is deliberate: every one of these has a silent-failure mode
 * that is far more expensive to diagnose after a successful deploy than a
 * refused synth is now. An unset CLERK_JWT_KEY, for instance, makes Clerk fall
 * back to fetching JWKS over the network, and the CMS Lambda has no internet --
 * so sign-in hangs rather than erroring.
 *
 * Note the empty-string check: GitHub Actions sets an env var to `''` when the
 * repository secret or variable behind it does not exist, so `??` would let a
 * missing secret through as a valid empty value.
 */
function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} must be set at synth time. In CI, set it as a repository secret ` +
        `or variable and pass it through the Deploy step's env: block in ` +
        `.github/workflows/deploy-cms.yml.`,
    )
  }
  return value
}

const app = new App()

new CmsStack(app, 'CanopyCms', {
  // An explicit account/region is required, not cosmetic: CanopyCmsDistribution
  // resolves your hosted zone with HostedZone.fromLookup, and a context lookup
  // in an environment-agnostic stack throws at synth even with valid
  // credentials. The CDK CLI populates both variables from your resolved
  // profile; leaving them unset keeps a credential-free `cdk synth` working for
  // the no-domain case below.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

  // The repository the EC2 worker pushes branches and opens PRs against.
  githubOwner: 'your-org',
  githubRepo: 'your-docs-site',

  // Secrets Manager ARNs. These must be the FULL ARN including the random
  // six-character suffix -- they are written verbatim into the worker's IAM
  // policy, so a name-based ARN silently never matches and the worker gets
  // AccessDenied at boot.
  githubTokenSecretArn: required('GITHUB_TOKEN_SECRET_ARN'),
  clerkSecretKeySecretArn: required('CLERK_SECRET_KEY_SECRET_ARN'),

  // Clerk's public JWKS PEM, for networkless session verification.
  clerkJwtKey: required('CLERK_JWT_KEY'),

  // Public material, inlined into the client bundle at image-build time. An
  // empty value deploys successfully and ships an editor that cannot sign in,
  // so it is worth checking after the first deploy.
  clerkPublishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || '',

  bootstrapAdminIds: process.env.CANOPY_BOOTSTRAP_ADMIN_IDS || '',

  // Namespaces this deployment's settings branch. Two stacks pointed at the
  // same GitHub repo MUST use different values. Changing it after the settings
  // workspace is populated is refused at boot -- see docs/deploying-to-aws.md.
  deploymentName: process.env.CANOPYCMS_DEPLOYMENT_NAME || 'prod',

  // Optional. Set both to put CloudFront + Route53 in front of the Lambda's
  // Function URL; leave them unset to use the Function URL directly, or to
  // point your own existing distribution at it.
  domainName: process.env.CMS_DOMAIN_NAME || undefined,
  hostedZoneDomain: process.env.CMS_HOSTED_ZONE_DOMAIN || undefined,
})
