import type { Octokit } from '@octokit/rest'

import type { CmsWorker } from '../worker/cms-worker'
import {
  createLocalGitHubGateway,
  type GitHubGateway,
  type LocalGitHubGatewayOptions,
} from '../worker/github-gateway'

interface WorkerGatewayInternals {
  gateway?: GitHubGateway
  localGitHubGatewayOptions(): LocalGitHubGatewayOptions
}

/**
 * Give `worker` the real in-process GitHub gateway, built from the worker's own options, with
 * GitHub replaced: `remoteUrl` is the repository standing in for it (resolved per use, so a
 * function can change or fail it mid-test), and `octokit` a stub of the Octokit calls the test
 * exercises. Install it before the worker first reaches GitHub; it replaces any gateway there.
 */
export function useLocalGitHubGateway(
  worker: CmsWorker,
  seams: { remoteUrl?: LocalGitHubGatewayOptions['remoteUrl']; octokit?: object } = {},
): GitHubGateway {
  const internals = worker as unknown as WorkerGatewayInternals
  const gateway = createLocalGitHubGateway({
    ...internals.localGitHubGatewayOptions(),
    ...(seams.remoteUrl !== undefined ? { remoteUrl: seams.remoteUrl } : {}),
    ...(seams.octokit !== undefined ? { octokit: seams.octokit as Octokit } : {}),
  })
  internals.gateway = gateway
  return gateway
}
