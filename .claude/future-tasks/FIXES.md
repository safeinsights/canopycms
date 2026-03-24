## Small fixes / open questions

- [ ] Lambda-friendly initialization: cache services in memory outside of request handler (singleton pattern)
- [ ] After you publish a branch, you can still save. Should editing be locked so reviewers see stable content? Also can't republish currently.

## Bigger items not listed in master plan

- [ ] SEO (meta tags, sitemap, robots.txt)
- [ ] GitHub build/deploy (to environment based on branch)
- [ ] PR workflows: accessibility checks? SEO check? Image shrinking?
- [ ] Assets: original-assets.safeinsights.org? then use image shrinker?
- [ ] Without even thinking about it from a how-to-do-it in code perspective, think through the editorial and development scenarios:
  - devs will still be coding -- do they go through dev/staging/production?
  - do content branches through Canopy never change the schema? What happens when the schema changes (because of a code change)
  - long lived vs short lived branches (I think short lived)
  - think through all the scenarios and plan them out
  - this will lead into the synchronization work
  - separately planner to scour all old plans in case we already thought about this

---

Assets uploaded in a branch only visible to that branch
Assets attached to collections
collection has assets.json? alt text, pointer to cloud
Once merged to main, visible to anyone with read access to the collection
when browsing asset manager, see any assets in current collection or higher
upload has hashed filename from content fingerprint, to replicated s3 bucket frontend by cloudfront (assets.safeinsights.org)
images are retrieved via image-cdn images.safeinsights.org/<URL to assets>/instructions
gotta handle PDFs, too. Potentially other file types.
