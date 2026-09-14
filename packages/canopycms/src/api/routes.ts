/**
 * Every route table, assembled for http/router.ts. Server-only: the tables
 * pull in node built-ins, so api/index.ts (reachable from client.ts) never
 * re-exports this module. `pnpm lint:bundle` holds that edge and the
 * `http-reaches-api-only-via-routes` dependency-cruiser rule holds this one.
 */

import type { RouteDefinition } from '../http/router'
import { BRANCH_ROUTES } from './branch'
import { WORKFLOW_ROUTES } from './branch-status'
import { COMMENT_ROUTES } from './comments'
import { CONTENT_ROUTES } from './content'
import { REFERENCE_OPTIONS_ROUTES } from './reference-options'
import { RESOLVE_REFERENCES_ROUTES } from './resolve-references'
import { ENTRY_ROUTES } from './entries'
import { ASSET_ROUTES, assetRawRoute } from './assets'
import { PERMISSION_ROUTES } from './permissions'
import { GROUP_ROUTES } from './groups'
import { USER_ROUTES } from './user'
import { SCHEMA_ROUTES } from './schema'
import { ADMIN_ROUTES } from './admin'

/**
 * A function, not a top-level constant, so every route module is fully
 * initialized before its exports are read.
 */
export function buildCanopyRoutes(): RouteDefinition[] {
  return [
    ...Object.values(BRANCH_ROUTES),
    ...Object.values(WORKFLOW_ROUTES),
    ...Object.values(COMMENT_ROUTES),
    ...Object.values(CONTENT_ROUTES),
    ...Object.values(REFERENCE_OPTIONS_ROUTES),
    ...Object.values(RESOLVE_REFERENCES_ROUTES),
    ...Object.values(ENTRY_ROUTES),
    ...Object.values(ASSET_ROUTES),
    assetRawRoute,
    ...Object.values(PERMISSION_ROUTES),
    ...Object.values(GROUP_ROUTES),
    ...Object.values(USER_ROUTES),
    ...Object.values(SCHEMA_ROUTES),
    ...Object.values(ADMIN_ROUTES),
  ].map(
    (route): RouteDefinition => ({
      method: route.method,
      pattern: route.pattern,
      handler: route.handler,
      validate: 'validate' in route ? (route.validate as RouteDefinition['validate']) : undefined,
      bodyFormat:
        'bodyFormat' in route ? (route.bodyFormat as RouteDefinition['bodyFormat']) : undefined,
    }),
  )
}
