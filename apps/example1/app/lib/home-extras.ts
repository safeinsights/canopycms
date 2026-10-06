import type { HomeExtras } from '../components/HomeView'
import type { NextCanopyContextResult } from 'canopycms-next'

// What the home view shows beyond its own entry. The public page and the preview route both call
// this, so a preview never shows a section the published page lacks.
export const loadHomeExtras = async (
  listEntries: NextCanopyContextResult['listEntries'],
  branch?: string,
): Promise<HomeExtras> => {
  const posts = await listEntries<{ title: string }>({
    rootPath: 'content/posts',
    branch,
    filter: (entry) => entry.entryType === 'post',
    extract: (raw) => ({ title: typeof raw.title === 'string' ? raw.title : '' }),
  })
  return {
    posts: posts
      .map((post) => ({ title: post.data.title || post.slug, href: post.urlPath }))
      .sort((a, b) => a.title.localeCompare(b.title)),
  }
}
