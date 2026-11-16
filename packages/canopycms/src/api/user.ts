import { defineEndpoint } from './route-builder'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { BuildIdentity } from '../types'
import { isAdmin } from '../authorization/helpers'
import { getBuildIdentity } from '../build-identity'
import { enrolSeenUser } from './people'

export type UserInfoResponse = ApiResponse<{
  userId: string
  groups: string[]
  /** Admins only: the deployed version is reconnaissance for anyone else. */
  build?: BuildIdentity
}>

/**
 * This is a PUBLIC endpoint - no special permissions required. The editor calls it before it
 * mounts (editor/EditorAuthGate.tsx), which is when someone holding a qualifying group joins the
 * people others can find (api/people.ts `enrolSeenUser`).
 */
const getUserInfoHandler = async (ctx: ApiContext, req: ApiRequest): Promise<UserInfoResponse> => {
  await enrolSeenUser(ctx, req.user)
  // Every authenticated request has req.user populated by the auth middleware
  return {
    ok: true,
    status: 200,
    data: {
      userId: req.user.userId,
      groups: req.user.groups as string[],
      ...(isAdmin(req.user.groups) ? { build: getBuildIdentity() } : {}),
    },
  }
}

const getUserInfo = defineEndpoint({
  namespace: 'user',
  name: 'whoami',
  method: 'GET',
  path: '/whoami',
  responseType: 'UserInfoResponse',
  response: {} as UserInfoResponse,
  defaultMockData: { userId: 'mock-user', groups: [] },
  handler: getUserInfoHandler,
})

export const USER_ROUTES = {
  whoami: getUserInfo,
} as const
