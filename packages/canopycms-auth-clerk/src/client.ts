'use client'

import { useClerk } from '@clerk/nextjs'
import { UserButton } from '@clerk/nextjs'
import type { CanopyClientConfig } from 'canopycms/client'

/**
 * Hook that provides Clerk-specific auth handlers and components for CanopyCMS editor.
 * Use this in your edit page to integrate Clerk authentication with CanopyCMS.
 *
 * @example
 * ```tsx
 * import { useClerkAuthConfig } from 'canopycms-auth-clerk/client'
 * import config from '../../canopycms.config'
 *
 * export default function EditPage() {
 *   const clerkAuth = useClerkAuthConfig()
 *   const editorConfig = config.client(clerkAuth)
 *   return <CanopyEditorPage config={editorConfig} />
 * }
 * ```
 */
export function useClerkAuthConfig(): Pick<CanopyClientConfig, 'editor'> {
  const { signOut } = useClerk()

  return {
    editor: {
      AccountComponent: UserButton,
      onLogoutClick: async () => {
        try {
          await signOut()
        } catch (error) {
          console.error('Failed to sign out:', error)
        }
      },
    },
  }
}
