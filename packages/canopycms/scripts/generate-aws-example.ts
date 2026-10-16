#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Regenerates `examples/aws-deployment/` from the `init-deploy aws` templates. Run after editing
 * any of them: `pnpm generate:aws-example`.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { AWS_DEPLOY_EXAMPLE_DIR, renderAwsDeployExample } from '../src/cli/aws-deploy-example'

for (const [relativePath, content] of await renderAwsDeployExample()) {
  const target = path.join(AWS_DEPLOY_EXAMPLE_DIR, relativePath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
  console.log(`wrote ${path.relative(process.cwd(), target)}`)
}
