import { HeroThumb } from '../../HeroThumb'
import { heroRef, type HomeData } from '../../hero-ref'
import { createPreviewPage, previewView } from '../../lib/canopy'
import { HomePreview } from '../HomePreview'

// The `createPreviewPage` route, loaded directly by `preview-first-paint.spec.ts`. Home's `load`
// hands its view a server-rendered thumbnail, so the route carries an image whose URL only the
// server computes.
export default createPreviewPage({
  views: {
    home: previewView({
      view: HomePreview,
      load: ({ entry }) => {
        const hero = heroRef((entry.data as HomeData).heroImage)
        return { thumb: hero ? <HeroThumb hero={hero} /> : null }
      },
    }),
  },
})
