import type { CanopyConfig } from '../config'

/** The base branch is unknown, and prod never assumes one. */
export class BaseBranchUnresolvedError extends Error {
  constructor(detail: string) {
    super(
      `CanopyCMS: ${detail} Set defaultBaseBranch in your CanopyCMS config to the branch ` +
        'editing branches fork from.',
    )
    this.name = 'BaseBranchUnresolvedError'
  }
}

/**
 * `config`'s resolved base branch. Prod resolves an unset one from the remote's HEAD
 * (createCanopyServices), so an unset value in prod means a path skipped that resolution, and it
 * throws rather than guessing 'main'. In the other modes a config that never went through
 * services keeps the 'main' default; services itself resolves dev's from git HEAD.
 */
export function baseBranchOf(config: Pick<CanopyConfig, 'mode' | 'defaultBaseBranch'>): string {
  if (config.defaultBaseBranch) return config.defaultBaseBranch
  if (config.mode === 'prod') {
    throw new BaseBranchUnresolvedError('the prod base branch has not been resolved.')
  }
  return 'main'
}
