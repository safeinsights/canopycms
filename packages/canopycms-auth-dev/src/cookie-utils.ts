import type { HeadersLike } from 'canopycms/auth'

export const DEV_USER_COOKIE_NAME = 'canopy-dev-user'
export const DEV_USER_COOKIE_MAX_AGE = 60 * 60 * 24 * 7 // 7 days
export const DEFAULT_USER_ID = 'dev_user1_2nK8mP4xL9'

/** Reserved cookie value for "signed out": with no cookie, dev auth uses the default user. */
export const DEV_SIGNED_OUT = '__canopy_signed_out__'

// Anchored, so a cookie whose name merely ends in "canopy-dev-user" is not read as this one.
const DEV_USER_COOKIE_PATTERN = new RegExp(`(?:^|;\\s*)${DEV_USER_COOKIE_NAME}=([^;]+)`)

/**
 * Server-side: Extract cookie value from HTTP headers
 */
export function getDevUserCookieFromHeaders(headers: HeadersLike): string | null {
  const cookie = headers.get('Cookie')
  if (!cookie) return null

  return cookie.match(DEV_USER_COOKIE_PATTERN)?.[1] ?? null
}

/**
 * Client-side: Read cookie from document.cookie
 */
export function getDevUserCookie(): string | null {
  if (typeof document === 'undefined') return null

  return document.cookie.match(DEV_USER_COOKIE_PATTERN)?.[1] ?? null
}

/**
 * Client-side: Set dev user cookie
 */
export function setDevUserCookie(userId: string): void {
  if (typeof document === 'undefined') return

  document.cookie = `${DEV_USER_COOKIE_NAME}=${userId}; path=/; max-age=${DEV_USER_COOKIE_MAX_AGE}; SameSite=Lax`
}

/** Client-side: sign out (clearing the cookie would only return to the default user). */
export function setDevSignedOutCookie(): void {
  setDevUserCookie(DEV_SIGNED_OUT)
}

/** Client-side: clear the cookie, returning to the default user. */
export function clearDevUserCookie(): void {
  if (typeof document === 'undefined') return

  document.cookie = `${DEV_USER_COOKIE_NAME}=; path=/; max-age=0`
}
