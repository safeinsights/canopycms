'use client'

import type { CanopyClientConfig } from 'canopycms/client'
import { UserSwitcherButton } from './UserSwitcherButton'
import { DevSignIn } from './DevSignIn'
import { setDevSignedOutCookie } from './cookie-utils'

export { DevSignIn } from './DevSignIn'

/**
 * Hook that provides dev auth handlers and components for CanopyCMS editor.
 * Model after: packages/canopycms-auth-clerk/src/client.ts
 *
 * @example
 * ```tsx
 * import { useDevAuthConfig } from 'canopycms-auth-dev/client'
 * import config from '../../canopycms.config'
 *
 * export default function EditPage() {
 *   const devAuth = useDevAuthConfig()
 *   const editorConfig = config.client(devAuth)
 *   return <CanopyEditorPage config={editorConfig} />
 * }
 * ```
 */
export function useDevAuthConfig(): Pick<CanopyClientConfig, 'editor'> {
  return {
    editor: {
      AccountComponent: UserSwitcherButton,
      SignInComponent: DevSignIn,
      onLogoutClick: () => {
        // A real sign-out: clearing the cookie would only return to the default user.
        setDevSignedOutCookie()
        window.location.reload()
      },
    },
  }
}
