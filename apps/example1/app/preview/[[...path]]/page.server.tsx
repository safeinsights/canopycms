import DocView from '../../components/DocView'
import HomeView from '../../components/HomeView'
import PostView from '../../components/PostView'
import { createPreviewPage } from '../../lib/canopy'

// The editor's preview pane loads every entry here (`editor.previewPrefix: '/preview'`). The
// `.server.tsx` extension keeps the route out of a static export build. An entry type with no view,
// like `author`, previews as a 404.
export default createPreviewPage({
  views: { home: HomeView, post: PostView, doc: DocView },
})
