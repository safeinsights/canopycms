import { Octokit } from '@octokit/rest'

/**
 * The error Octokit itself throws when GitHub answers `status` with the JSON `body`, produced by
 * running a real request through a stub fetch, so classifiers are tested against the library's
 * own error shape rather than a hand-built imitation.
 */
export async function octokitErrorFor(status: number, body: object): Promise<Error> {
  const octokit = new Octokit({
    request: {
      fetch: async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
    },
  })
  try {
    await octokit.pulls.create({ owner: 'o', repo: 'r', head: 'h', base: 'main', title: 't' })
  } catch (err) {
    if (err instanceof Error) return err
    throw new Error(`octokitErrorFor: Octokit threw a non-Error: ${String(err)}`)
  }
  throw new Error(`octokitErrorFor: a ${status} response did not throw`)
}

/** GitHub's answer to a PR whose head has no commits its base lacks. */
export function noCommitsBetweenError(base = 'main', head = 'feature-1'): Promise<Error> {
  return octokitErrorFor(422, {
    message: 'Validation Failed',
    errors: [
      {
        resource: 'PullRequest',
        code: 'custom',
        message: `No commits between ${base} and ${head}`,
      },
    ],
    documentation_url: 'https://docs.github.com/rest/pulls/pulls#create-a-pull-request',
    status: '422',
  })
}
