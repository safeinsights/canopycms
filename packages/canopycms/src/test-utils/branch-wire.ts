/**
 * The `/:branch` segment of an editor request in both forms it takes: plainly before the branch
 * listing arrives, and exactly (`refs/heads/<name>`) once the listing holds the branch
 * (editor/hooks/useBranchManager.tsx's segments).
 */

const BRANCH_PATH = /^(\/api\/canopycms\/)([^/?]+)/

/** `path` (`/api/canopycms/<branch>/...`) as a request sends it once its branch is listed. */
export function listedBranchPath(path: string): string {
  return path.replace(
    BRANCH_PATH,
    (_, prefix: string, branch: string) =>
      `${prefix}${encodeURIComponent(`refs/heads/${decodeURIComponent(branch)}`)}`,
  )
}

/** `url` with an exact branch segment written plainly, so a stub answers either form alike. */
export function plainBranchPath(url: string): string {
  return url.replace(BRANCH_PATH, (whole, prefix: string, branch: string) => {
    const decoded = decodeURIComponent(branch)
    return decoded.startsWith('refs/heads/')
      ? `${prefix}${encodeURIComponent(decoded.slice('refs/heads/'.length))}`
      : whole
  })
}
