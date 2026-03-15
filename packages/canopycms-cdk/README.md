# canopycms-cdk

AWS CDK constructs and EC2 worker for deploying CanopyCMS.

## What's Included

### CDK Constructs

**`CanopyCmsService`** — Core infrastructure (required):
- VPC (2 AZs, public + private subnets, no NAT Gateway)
- EFS filesystem with `/workspace` access point
- Lambda function (Docker image, EFS mount, private subnet, no internet)
- Lambda Function URL (for CloudFront origin)
- EC2 Worker (t4g.nano spot in ASG, public subnet, EFS mount)
- Security groups and IAM roles (least-privilege)

**`CanopyCmsDistribution`** — CloudFront + DNS (optional):
- ACM certificate with DNS validation
- CloudFront distribution with Lambda Function URL origin
- Route53 A/AAAA alias records
- Cache policies: no-cache for API/editor, long-cache for static assets

Use `CanopyCmsDistribution` if you don't have existing CloudFront infrastructure. Otherwise, use the `functionUrl` output from `CanopyCmsService` and wire it into your own CloudFront setup.

### EC2 Worker

The `worker/` directory contains the EC2 worker entrypoint for AWS deployments. It:
- Reads secrets from AWS Secrets Manager
- Wires up the Clerk-specific auth cache refresher
- Starts the `CmsWorker` daemon from `canopycms` core

The `CmsWorker` class itself lives in `canopycms/worker/cms-worker` and is cloud-agnostic. This package re-exports it for convenience.

## Usage

```typescript
import { CanopyCmsService, CanopyCmsDistribution } from 'canopycms-cdk'
import { DockerImageAsset } from 'aws-cdk-lib/aws-ecr-assets'

// Core infrastructure
const cmsService = new CanopyCmsService(this, 'CmsService', {
  cmsDockerImage: lambda.DockerImageCode.fromImageAsset('.'),
  secretsArns: [githubTokenSecret.secretArn, clerkSecretKeySecret.secretArn],
  environment: {
    CLERK_JWT_KEY: clerkJwtKey,
    CANOPY_BOOTSTRAP_ADMIN_IDS: adminIds,
  },
})

// Optional: turnkey CloudFront + DNS
const cmsDist = new CanopyCmsDistribution(this, 'CmsDist', {
  functionUrl: cmsService.functionUrl,
  domainName: 'cms.docs.example.org',
  hostedZoneDomain: 'example.org',
})
```

## Architecture

```
CloudFront → Lambda Function URL → Lambda (VPC, no internet)
                                        ↕ EFS
                                   EC2 Worker (internet) → GitHub
```

Lambda handles all CMS operations using local EFS storage. The EC2 worker handles internet-requiring operations (GitHub push/PR, auth cache refresh). They communicate via the shared EFS filesystem.

See [ARCHITECTURE.md](../../ARCHITECTURE.md#deployment-architecture) for details.

## Cost

| Resource | Monthly Cost |
|----------|-------------|
| EC2 t4g.nano spot (ASG 1/1/1) | ~$1.50 |
| Lambda (editors only) | ~$1-5 |
| EFS (small repo) | ~$1 |
| CloudFront (low traffic) | ~$1 |
| **Total** | **~$5-9/month** |

## What Adopters Provide

| Responsibility | Why |
|---------------|-----|
| Docker image (from their app) | App-specific |
| Secrets Manager entries | Site-specific secrets |
| CloudFront + DNS (if not using `CanopyCmsDistribution`) | Existing infra varies |
| GitHub Actions CI/CD | CI/CD patterns vary |
