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
  email_addresses?: Array<{ id?: string; email_address: string }> | null
  primary_email_address_id?: string | null
}

/** The first non-blank name, else undefined: never the id (an internal name) or any email part. */
export function clerkDisplayName(user: ClerkUserData): string | undefined {
  for (const candidate of [user.fullName, user.full_name, user.username]) {
    const trimmed = candidate?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

/** The snake_case shape's primary address; its first only when it names no primary at all. */
function snakeCasePrimaryEmail(user: ClerkUserData): string | undefined {
  const addresses = user.email_addresses ?? []
  const primaryId = user.primary_email_address_id
  if (!primaryId) return addresses[0]?.email_address
  return addresses.find((address) => address.id === primaryId)?.email_address
}

export function toUserSearchResult(user: ClerkUserData): UserSearchResult {
  return {
    id: user.id,
    name: clerkDisplayName(user) ?? '',
    email: user.primaryEmailAddress?.emailAddress ?? snakeCasePrimaryEmail(user) ?? '',
    avatarUrl: user.imageUrl ?? user.image_url ?? undefined,
  }
}
