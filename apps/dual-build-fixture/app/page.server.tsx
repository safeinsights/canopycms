// CMS/server build (and plain `next dev`): render every request at request
// time so runtime path ACLs apply. No build-time prerender here -- see
// README.md's "Dual-Build Sites" section for why a prerendered CMS build
// would serve build-time content to every visitor, bypassing ACLs.
export { default } from './home-content'
export const dynamic = 'force-dynamic'
