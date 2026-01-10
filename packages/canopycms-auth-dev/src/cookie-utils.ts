import type { HeadersLike } from 'canopycms/auth'

export const DEV_USER_COOKIE_NAME = 'canopy-dev-user'
export const DEV_USER_COOKIE_MAX_AGE = 60 * 60 * 24 * 7 // 7 days
export const DEFAULT_USER_ID = 'devuser_2nK8mP4xL9'

/**
 * Server-side: Extract cookie value from HTTP headers
 */
export function getDevUserCookieFromHeaders(headers: HeadersLike): string | null {
  const cookie = headers.get('Cookie')
  if (!cookie) return null

  const match = cookie.match(new RegExp(`${DEV_USER_COOKIE_NAME}=([^;]+)`))
  return match?.[1] ?? null
}

/**
 * Client-side: Read cookie from document.cookie
 */
export function getDevUserCookie(): string | null {
  if (typeof document === 'undefined') return null

  const match = document.cookie.match(new RegExp(`${DEV_USER_COOKIE_NAME}=([^;]+)`))
  return match?.[1] ?? null
}

/**
 * Client-side: Set dev user cookie
 */
export function setDevUserCookie(userId: string): void {
  if (typeof document === 'undefined') return

  document.cookie = `${DEV_USER_COOKIE_NAME}=${userId}; path=/; max-age=${DEV_USER_COOKIE_MAX_AGE}; SameSite=Lax`
}

/**
 * Client-side: Clear dev user cookie (logout)
 */
export function clearDevUserCookie(): void {
  if (typeof document === 'undefined') return

  document.cookie = `${DEV_USER_COOKIE_NAME}=; path=/; max-age=0`
}
