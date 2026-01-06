import { defineEndpoint } from './route-builder'
import type { ApiContext, ApiRequest, ApiResponse } from './types'

export type UserInfoResponse = ApiResponse<{
  userId: string
  groups: string[]
}>

/**
 * Get current user info
 * This is a PUBLIC endpoint - no special permissions required
 */
const getUserInfoHandler = async (ctx: ApiContext, req: ApiRequest): Promise<UserInfoResponse> => {
  // Every authenticated request has req.user populated by the auth middleware
  return {
    ok: true,
    status: 200,
    data: {
      userId: req.user.userId,
      groups: req.user.groups as string[],
    },
  }
}

/**
 * Get current user information
 * GET /whoami
 */
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
