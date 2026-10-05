import { DocPreview } from '../../components/DocView'
import { HomePreview } from '../../components/HomeView'
import { PostPreview } from '../../components/PostView'
import { createPreviewPage } from '../../lib/canopy'

// The editor's preview pane loads every entry here (`editor.previewPrefix: '/preview'`). The
// `.server.tsx` extension keeps the route out of a static export build. An entry type with no view,
// like `author`, previews as a 404.
export default createPreviewPage({
  views: { home: HomePreview, post: PostPreview, doc: DocPreview },
})
