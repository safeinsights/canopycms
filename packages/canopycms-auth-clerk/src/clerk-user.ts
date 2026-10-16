import type { UserSearchResult } from 'canopycms/auth'

/** Covers both the camelCase and snake_case shapes of different Clerk SDK versions. */
export interface ClerkUserData {
  id: string
  username?: string | null
  fullName?: string | null
  full_name?: string | null
  imageUrl?: string | null
  image_url?: string | null
  primaryEmailAddress?: { emailAddress: string } | null
  email_addresses?: Array<{ email_address: string }> | null
}

/** The first non-blank name, else undefined: never the id (an internal name) or any email part. */
export function clerkDisplayName(user: ClerkUserData): string | undefined {
  for (const candidate of [user.fullName, user.full_name, user.username]) {
    const trimmed = candidate?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

export function toUserSearchResult(user: ClerkUserData): UserSearchResult {
  return {
    id: user.id,
    name: clerkDisplayName(user) ?? '',
    email: user.primaryEmailAddress?.emailAddress ?? user.email_addresses?.[0]?.email_address ?? '',
    avatarUrl: user.imageUrl ?? user.image_url ?? undefined,
  }
}
