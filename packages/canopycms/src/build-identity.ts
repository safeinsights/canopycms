import type { BuildIdentity } from './types'
import { CANOPYCMS_VERSION } from './version'

export type { BuildIdentity }

/**
 * Set by the image build (Dockerfile.cms `ARG`), not by the infrastructure: a Lambda env var
 * would name the infrastructure's commit and hide an image/infrastructure skew.
 */
const SOURCE_REVISION_ENV = 'CANOPY_SOURCE_SHA'

export function getBuildIdentity(env: NodeJS.ProcessEnv = process.env): BuildIdentity {
  // The Dockerfile sets the variable to the empty string when the build arg is not passed.
  const sourceRevision = env[SOURCE_REVISION_ENV]?.trim()
  return sourceRevision
    ? { canopycmsVersion: CANOPYCMS_VERSION, sourceRevision }
    : { canopycmsVersion: CANOPYCMS_VERSION }
}
