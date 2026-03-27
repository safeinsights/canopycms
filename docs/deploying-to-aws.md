# Deploying CanopyCMS to AWS

This guide walks through deploying CanopyCMS on AWS using Lambda + EFS + EC2 Worker. This architecture costs ~$5-9/month and is designed for low-traffic CMS editing workflows.

## Architecture Overview

```
Editor browser
    │
    ▼
CloudFront (cms.docs.example.org)
    │
    ▼
Lambda (VPC, no internet)               EC2 Worker (t4g.nano spot)
    │                                        │
    ├── JWT verification (networkless)       ├── git push/pull ↔ GitHub
    ├── User metadata (EFS cache)            ├── GitHub API (PRs)
    ├── Git ops (local file:// URL)          ├── Refresh auth cache → EFS
    ├── Content read/write (EFS)             ├── Rebase branches
    └── Queue async tasks → EFS              └── Process task queue
            │                                        │
            └────────── EFS (shared) ────────────────┘
```

**Why this architecture?**

- **No NAT Gateway** — Lambda has no internet access, saving ~$32/month
- **Secrets stay on the worker** — Lambda only has public keys and config
- **Same app, two builds** — The adopter's Next.js app builds as both a static export (public site) and a standalone server (CMS Lambda)
- **Preview works** — The CMS Lambda renders the same React components as the public site, so the editor's preview iframe shows accurate previews

## Prerequisites

- AWS account with CDK bootstrapped
- GitHub repo with your site content
- Clerk account (or plan to use dev auth for testing)
- Node.js 20+

## Step 1: Add CanopyCMS to Your App

Run the bootstrapping script in your Next.js app:

```bash
npx canopycms init
```

This creates:

- `canopycms.config.ts` — CanopyCMS configuration
- `app/lib/canopy.ts` — Server-side context (auth plugin selection)
- `app/schemas.ts` — Entry schema definitions (customize for your content)
- `app/api/canopycms/[...canopycms]/route.ts` — Catch-all API handler
- `app/edit/page.tsx` — Editor page

**Customize `app/schemas.ts`** to match your content structure. Each collection's `.collection.json` file references an entry schema by name.

### Dual Build Support

Your `next.config.ts` needs to support two build modes:

```typescript
import { withCanopy } from 'canopycms-next'

export default withCanopy({
  output: process.env.CANOPY_BUILD === 'cms' ? 'standalone' : 'export',
})
```

- `npm run build` → static export for S3 (public site)
- `CANOPY_BUILD=cms npm run build` → standalone server for Lambda (CMS)

### Preview Support

Add `useCanopyPreview` to your page components so the editor can show live previews:

```tsx
'use client'
import { useCanopyPreview } from 'canopycms/client'

export function PageView({ data }: { data: PageContent }) {
  const { data: liveData } = useCanopyPreview<PageContent>({
    initialData: data,
  })
  return (
    <article>
      <h1>{liveData.title}</h1>
    </article>
  )
}
```

## Step 2: Generate AWS Deployment Artifacts

```bash
npx canopycms init-deploy aws
```

This creates:

- `Dockerfile.cms` — Lambda Web Adapter image
- `.github/workflows/deploy-cms.yml` — CI/CD workflow template

## Step 3: Test Locally in prod-sim Mode

Before deploying, test the full workflow locally:

```bash
# Set mode in canopycms.config.ts to 'prod-sim'
npm run dev

# In another terminal, initialize the auth cache:
npx canopycms worker run-once

# Visit http://localhost:3000/edit
```

In prod-sim mode, CanopyCMS:

- Creates a local bare repo at `.canopy-prod-sim/remote.git`
- Uses `CachingAuthPlugin` with file-based cache (same code path as prod)
- Queues PR tasks to `.canopy-prod-sim/.tasks/` (processed by `run-once`)

## Step 4: CDK Stack

Install the CDK constructs:

```bash
npm install canopycms-cdk aws-cdk-lib constructs
```

Create your CDK stack:

```typescript
// infrastructure/lib/cms-stack.ts
import { Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { CanopyCmsService, CanopyCmsDistribution } from 'canopycms-cdk'

export class CmsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    // Secrets (create these manually or via CDK)
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

    // Core infrastructure
    const cmsService = new CanopyCmsService(this, 'CmsService', {
      cmsDockerImage: lambda.DockerImageCode.fromImageAsset('.'),
      githubOwner: 'your-org',
      githubRepo: 'your-docs-site',
      secretsArns: [githubToken.secretArn, clerkSecretKey.secretArn],
      githubTokenSecretArn: githubToken.secretArn,
      clerkSecretKeySecretArn: clerkSecretKey.secretArn,
      environment: {
        CANOPY_AUTH_MODE: 'clerk',
        CLERK_JWT_KEY: process.env.CLERK_JWT_KEY ?? '',
        CANOPY_BOOTSTRAP_ADMIN_IDS: 'user_xxx,user_yyy',
      },
    })

    // CloudFront + DNS (optional — use your own if you have existing infra)
    new CanopyCmsDistribution(this, 'CmsDist', {
      functionUrl: cmsService.functionUrl,
      domainName: 'cms.docs.example.org',
      hostedZoneDomain: 'example.org',
    })
  }
}
```

Deploy:

```bash
cdk deploy CmsStack
```

## Step 5: CI/CD

The generated `.github/workflows/deploy-cms.yml` is a template. Customize it for your setup:

```yaml
name: Deploy CMS
on:
  push:
    paths: ['app/**', 'content/**', 'canopycms.config.ts']
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::ACCOUNT:role/deploy-role
          aws-region: us-east-1

      - name: Login to ECR
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push CMS image
        run: |
          docker build -f Dockerfile.cms -t $ECR_REPO:latest .
          docker push $ECR_REPO:latest

      - name: Update Lambda
        run: |
          aws lambda update-function-code \
            --function-name CmsFunction \
            --image-uri $ECR_REPO:latest
```

## Step 6: Create Secrets

Before deploying, create these secrets in AWS Secrets Manager:

| Secret                       | Value                        | Used by                         |
| ---------------------------- | ---------------------------- | ------------------------------- |
| `canopycms/github-token`     | GitHub PAT with `repo` scope | EC2 worker (push, PR creation)  |
| `canopycms/clerk-secret-key` | Clerk backend secret key     | EC2 worker (user cache refresh) |

The Lambda does NOT need these secrets — only the EC2 worker reads them.

## Content Publishing Flow

1. Editor creates/edits content in the CMS at `cms.docs.example.org/edit`
2. Editor clicks "Submit" → Lambda commits to branch, pushes to `remote.git` on EFS
3. EC2 worker picks up task (~5 seconds) → pushes branch to GitHub, creates PR
4. Reviewer merges PR on GitHub
5. Existing CI/CD pipeline rebuilds the static site and deploys to S3

## Settings Publishing Flow (Permissions & Groups)

Settings changes (permissions and groups) follow the same Lambda→worker pattern as content, using a dedicated settings branch named `canopycms-settings-{deploymentName}` (e.g., `canopycms-settings-prod`):

1. Admin changes permissions/groups in the CMS UI
2. Lambda commits changes to the settings branch workspace on EFS
3. Lambda pushes the commit to `remote.git` (local bare repo on EFS)
4. Lambda queues a `push-and-create-or-update-pr` task for the worker
5. EC2 worker dequeues the task, pushes the settings branch from `remote.git` to GitHub, and creates/updates a PR
6. Additionally, the worker's `syncGit()` pushes settings branches on every cycle as a safety net

## Security Model

| Lambda                           | EC2 Worker                                      |
| -------------------------------- | ----------------------------------------------- |
| No internet access               | Outbound HTTPS only                             |
| No sensitive secrets             | GitHub token + Clerk key (from Secrets Manager) |
| Public keys only (CLERK_JWT_KEY) | Full API access                                 |
| Read/write EFS only              | Read/write EFS + internet                       |

If Lambda is compromised, an attacker can read/write content on EFS but cannot exfiltrate data, push to GitHub, or access any external service.

## Environments

CanopyCMS handles one deployment. Instantiate the CDK stack multiple times for different environments:

```typescript
// Testing CMS (sandbox account)
new CmsStack(app, 'CmsTest', {
  env: { account: '111111111111', region: 'us-east-1' },
})

// Production CMS (official account)
new CmsStack(app, 'CmsProd', {
  env: { account: '222222222222', region: 'us-east-1' },
})
```

## Troubleshooting

**Lambda cold start is slow**: Consider adding provisioned concurrency (1 instance, ~$15/month).

**Tasks stuck in pending**: Check if the EC2 worker is running. `systemctl status canopy-worker` on the EC2 instance.

**Auth cache empty**: Run `npx canopycms worker run-once` to populate, or wait for the EC2 worker's 15-minute refresh cycle.

**Preview not rendering**: Make sure your page components use `useCanopyPreview` and the CMS Lambda has the same React components as the public site (same app, two builds).
