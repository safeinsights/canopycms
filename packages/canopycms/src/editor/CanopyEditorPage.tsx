import type { CanopyClientConfig } from '../config'
import type { CustomFieldRenderers } from './FormRenderer'
import { CanopyEditor } from './CanopyEditor'

/**
 * @param customRenderers Optional adopter overrides for how specific field
 * types render (see `FormRenderer`'s `customRenderers` prop). Threaded
 * through to `CanopyEditor` so the extension point is reachable from the
 * page-factory entrypoint, not just from a direct `<CanopyEditor>`/`<Editor>`
 * usage.
 */
export const CanopyEditorPage = (
  config: CanopyClientConfig,
  customRenderers?: CustomFieldRenderers,
) => {
  const CanopyEditorPageInner = ({
    searchParams,
  }: {
    searchParams?: { branch?: string; entry?: string }
  }) => {
    // No 'main' fallback: when nothing pins a branch, the editor starts
    // branchless and adopts the server's detected default from the branches
    // API (see useBranchManager.loadBranches).
    const branchName =
      searchParams?.branch ?? config.defaultActiveBranch ?? config.defaultBaseBranch
    const initialSelectedId = searchParams?.entry
    return (
      <CanopyEditor
        config={config}
        branchName={branchName}
        initialSelectedId={initialSelectedId}
        entries={[]}
        customRenderers={customRenderers}
      />
    )
  }
  CanopyEditorPageInner.displayName = 'CanopyEditorPage'
  return CanopyEditorPageInner
}

export default CanopyEditorPage
