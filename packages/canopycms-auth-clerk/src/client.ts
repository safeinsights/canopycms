'use client'

import { useClerk } from '@clerk/nextjs'
import { UserButton } from '@clerk/nextjs'
import type { CanopyClientConfig } from 'canopycms/client'
import { ClerkSignIn } from './ClerkSignIn'
import { useSkipClerkSetActiveAction } from './skip-set-active-action'

export { ClerkSignIn, type ClerkSignInProps } from './ClerkSignIn'
export { useSkipClerkSetActiveAction } from './skip-set-active-action'

/**
 * Hook that provides Clerk-specific auth handlers and components for CanopyCMS editor.
 *
 * Includes the sign-in screen (`ClerkSignIn`), with or without `clerkMiddleware`. Customize it
 * at module scope: `SignInComponent: (p) => <ClerkSignIn {...p} signInProps={...} />`.
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
  useSkipClerkSetActiveAction()

  return {
    editor: {
      AccountComponent: UserButton,
      SignInComponent: ClerkSignIn,
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
