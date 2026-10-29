/**
 * The `/:branch` segment of an editor request in both forms it takes: plainly before the branch
 * listing arrives, unless the name holds a `/` (editor/branch-names.ts `unlistedSegment`), and
 * exactly (`exactBranchSegment`, `~canopycms~prod~spring`) once the listing holds the branch
 * (editor/hooks/useBranchManager.tsx's segments).
 */
import { exactBranchName, exactBranchSegment } from '../paths/validation'

const BRANCH_PATH = /^(\/api\/canopycms\/)([^/?]+)/

/** `path` (`/api/canopycms/<branch>/...`) as a request sends it once its branch is listed. */
export function listedBranchPath(path: string): string {
  return path.replace(
    BRANCH_PATH,
    (_, prefix: string, branch: string) =>
      `${prefix}${encodeURIComponent(exactBranchSegment(decodeURIComponent(branch)))}`,
  )
}

/** `url` with an exact branch segment written plainly, so a stub answers either form alike. */
export function plainBranchPath(url: string): string {
  return url.replace(BRANCH_PATH, (whole, prefix: string, branch: string) => {
    const full = exactBranchName(decodeURIComponent(branch))
    return full === null ? whole : `${prefix}${encodeURIComponent(full)}`
  })
}
