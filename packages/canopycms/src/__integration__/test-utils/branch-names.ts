import { sanitizeBranchName } from '../../paths/branch-name'

/** The namespace every branch an editor creates in dev mode starts with. */
export const DEV_BRANCH_NAMESPACE = 'canopycms/local/'

/** The ref of the branch typed as `short`: branch.json's `name`, git's branch name, the API's `branch.name`. */
export const branchRef = (short: string): string => `${DEV_BRANCH_NAMESPACE}${short}`

/** The workspace directory and registry key of the branch typed as `short`. */
export const branchKey = (short: string): string => sanitizeBranchName(branchRef(short))
