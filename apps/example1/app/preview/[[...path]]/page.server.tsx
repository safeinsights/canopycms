import { DocPreview } from '../../components/DocView'
import { HomePreview } from '../../components/HomeView'
import { PostPreview } from '../../components/PostView'
import { createPreviewPage, previewView } from '../../lib/canopy'
import { loadHomeExtras } from '../../lib/home-extras'

// The editor's preview pane loads every entry here (`editor.previewPrefix: '/preview'`). The
// `.server.tsx` extension keeps the route out of a static export build. An entry type with no view,
// like `author`, previews as a 404.
//
// A view that needs more than its own entry is paired with a `load`: it runs on the server, after
// the entry is read, and returns plain data that arrives as the view's `extras` prop. The public
// home page passes the same `loadHomeExtras` result.
export default createPreviewPage({
  views: {
    home: previewView({
      view: HomePreview,
      load: ({ canopy, branch }) => loadHomeExtras(canopy.listEntries, branch),
    }),
    post: PostPreview,
    doc: DocPreview,
  },
})
