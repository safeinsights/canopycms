import { defineAIContentConfig } from 'canopycms/ai'

export const aiContentConfig = defineAIContentConfig({
  // Full content tree included by default
  // Optional: exclude specific content
  // exclude: {
  //   collections: ['content/drafts'],
  //   entryTypes: ['internal-note'],
  // },
  // Optional: custom bundles
  // bundles: [
  //   {
  //     name: 'published-posts',
  //     description: 'All published blog posts',
  //     filter: {
  //       collections: ['posts'],
  //       where: (entry) => entry.data.published === true,
  //     },
  //   },
  // ],
  // Optional: fold a colocated, machine-generated sibling artifact into an entry's AI markdown.
  // Runs once per entry; the appended section flows into the per-entry file, all.md, and bundles.
  // readSibling reads a file next to the entry (traversal-guarded; null if missing).
  // entryTransforms: {
  //   dataset: async (entry, { contentId, readSibling }) => {
  //     const raw = await readSibling(`${contentId}.profile.json`)
  //     if (!raw) return
  //     return renderProfileSchema(entry.data, JSON.parse(raw)) // your own merge + renderer
  //   },
  // },
})
