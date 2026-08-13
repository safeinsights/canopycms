# AWS Deployment Example

Reference implementation for deploying CanopyCMS to AWS using the Lambda + EFS + EC2 Worker architecture.

**These files are what `npx canopycms init-deploy aws` scaffolds into an adopter's repository** — rendered here
with placeholder values (`your-org/your-docs-site`, npm, a `main` trigger branch) that the command fills in from
the project it runs in. Read them to see what you are getting before you run it, or copy them by hand if you
would rather not.

See [docs/deploying-to-aws.md](../../docs/deploying-to-aws.md) for the full walkthrough.

## Files

- `cdk.json` — CDK app configuration. `cdk deploy` with no `--app` resolves the app through this file, so
  without it the deploy workflow fails on its first step.
- `infrastructure/bin/app.ts` — CDK app entry point. Reads configuration from the environment so the same file
  works locally and in CI; the values with no default refuse to synth when unset.
- `infrastructure/lib/cms-stack.ts` — the stack: VPC + EFS + CMS Lambda + EC2 worker, and optionally
  CloudFront + Route53.
- `deploy-cms.yml` — GitHub Actions workflow. Belongs at `.github/workflows/deploy-cms.yml`.

`cdk deploy` is the only thing that ships code here — see the comments in `deploy-cms.yml` for why pairing it
with an ECR push plus `aws lambda update-function-code` silently reverts your Lambda on the next deploy.
