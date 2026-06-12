import type { CanopyClientConfig } from '../config'
import { CanopyEditor } from './CanopyEditor'

export const CanopyEditorPage = (config: CanopyClientConfig) => {
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
      />
    )
  }
  CanopyEditorPageInner.displayName = 'CanopyEditorPage'
  return CanopyEditorPageInner
}

export default CanopyEditorPage
