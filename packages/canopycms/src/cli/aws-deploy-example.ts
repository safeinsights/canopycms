/**
 * Renders `examples/aws-deployment/` from the `init-deploy aws` templates, through the same
 * functions the CLI calls. `scripts/generate-aws-example.ts` writes the result and
 * `aws-deploy-example.test.ts` fails when the checked-in copy differs, so a template edit cannot
 * leave the example behind.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLACEHOLDER_GITHUB_REPO, commandsFor } from './project-detect'
import { cdkApp, cdkJson, cdkTsconfig, cmsStack, githubWorkflowCms } from './templates'

export const AWS_DEPLOY_EXAMPLE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../examples/aws-deployment',
)

/** Every generated file, keyed by its path under `AWS_DEPLOY_EXAMPLE_DIR`. */
export async function renderAwsDeployExample(): Promise<Map<string, string>> {
  // What `init-deploy aws` falls back to when it detects nothing: npm, the `main` branch, and the
  // placeholder repository.
  const npm = commandsFor('npm')
  return new Map([
    ['cdk.json', await cdkJson()],
    [
      'infrastructure/bin/app.ts',
      await cdkApp({
        githubOwner: PLACEHOLDER_GITHUB_REPO.owner,
        githubRepo: PLACEHOLDER_GITHUB_REPO.repo,
      }),
    ],
    ['infrastructure/lib/cms-stack.ts', await cmsStack()],
    ['infrastructure/tsconfig.json', await cdkTsconfig()],
    // The CLI writes this to `.github/workflows/`; at the example's top level GitHub shows it
    // without running it.
    [
      'deploy-cms.yml',
      await githubWorkflowCms({
        defaultBranch: 'main',
        lockfile: npm.lockfile,
        ciInstall: npm.ciInstall,
        addDev: npm.addDev,
      }),
    ],
  ])
}
