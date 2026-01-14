Little

* [ ] Rename BranchMode -> OperatingMode
* [ ] getWorkerSuffix -> getCanopyDataRootSuffix


Let's fix these issues and add tests for them

1. [ ] permissions should point to IDs (for some move resiliency); groups should have random IDs (probably don't need manual IDs); group permissions should reference IDs
2. [ ] Admins and Reviewers groups should be autocreated if they don't exist. (can we simply check in empty to groups.json?)
8. [ ] Lambda-friendly initialization storage in memory outside of request
10. [ ] Is content navigator filtered by permission?
11. [ ] Final decision on where permissions and groups are stored -- like do we publish them in the normal flow?
12. [ ] YAML as easier way to see MDX? Markdown editors that do MDX?
13. [ ] Prevent someone from making a canopycms-settings branch, or switching to it


Bigger not listed in master plan

1. [ ] After you publish a branch, you can still save. Should you be able to, or should it be locked for editing so the ground doesn't change from under the reviewers feet. You also can't republish.
1. [ ] Branch ACLs (how we share branches)
1. [ ] SEO
12. [ ] Ordering of collection entries
3. [ ] GitHub build, deploy (to environment based on branch)
4. [ ] PR workflows, can we do accessibility checks? SEO check? Image shrinking?
5. [ ] Assets: original-assets.safeinsights.org? then use image shrinker?
6. [ ] Without even thinking about it from a how-to-do-it in code perspective, think through the editorial and development scenarios:
     - devs will still be coding -- do they go through dev/staging/production?
     - do content branches through Canopy never change the schema? What happens when the schema changes (because of a code change)
     - long lived vs short lived branches (I think short lived)
     - think through all the scenarios and plan them out
     - this will lead into the synchronization work
     - separately planner to scour all old plans in case we already thought about this
7. [ ] User (clerk) data caching, like for 5 mins (keep name and such)


----
Assets uploaded in a branch only visible to that branch
Assets attached to collections
collection has assets.json? alt text, pointer to cloud
Once merged to main, visible to anyone with read access to the collection
when browsing asset manager, see any assets in current collection or higher
upload has hashed filename from content fingerprint, to replicated s3 bucket frontend by cloudfront (assets.safeinsights.org)
images are retrieved via image-cdn images.safeinsights.org/<URL to assets>/instructions
gotta handle PDFs, too. Potentially other file types.
