import type { CanopyClientConfig } from '../config'
import { CanopyEditor } from './CanopyEditor'

export const CanopyEditorPage = (config: CanopyClientConfig) => {
  const CanopyEditorPageInner = ({
    searchParams,
  }: {
    searchParams?: { branch?: string; entry?: string }
  }) => {
    const branchName =
      searchParams?.branch ?? config.defaultActiveBranch ?? config.defaultBaseBranch ?? 'main'
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
