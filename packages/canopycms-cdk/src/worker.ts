/**
 * Re-export CmsWorker from the core canopycms package.
 * The worker is cloud-agnostic and auth-agnostic — it lives in canopycms core.
 * This file re-exports it for convenience from the CDK package.
 */
export { CmsWorker } from 'canopycms/worker/cms-worker'
export type { CmsWorkerConfig, AuthCacheRefresher } from 'canopycms/worker/cms-worker'
