# AWS Deployment Example

Reference implementation for deploying CanopyCMS to AWS using the Lambda + EFS + EC2 Worker architecture.

This directory contains example CDK stack and CI/CD configuration that adopters can adapt for their own deployment.

See [docs/deploying-to-aws.md](../../docs/deploying-to-aws.md) for the full walkthrough.

## Files

- `cms-stack.ts` — Example CDK stack using `canopycms-cdk` constructs
- `deploy-cms.yml` — Example GitHub Actions workflow for CMS deployment
