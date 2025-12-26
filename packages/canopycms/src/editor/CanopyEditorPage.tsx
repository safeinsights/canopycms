import type { CanopyClientConfig } from '../config'
import { CanopyEditor } from './CanopyEditor'

export const CanopyEditorPage = (config: CanopyClientConfig) => {
  return ({ searchParams }: { searchParams?: { branch?: string; entry?: string } }) => {
    const branchName = searchParams?.branch ?? config.defaultBaseBranch ?? 'main'
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
}

export default CanopyEditorPage
