Little

* [ ] Rename BranchMode -> OperatingMode
* [ ] getWorkerSuffix -> getCanopyDataRootSuffix


Let's fix these issues and add tests for them

1. [ ] User search from group UI hits search API and gets {"ok":false,"status":400,"error":"Query parameter \"q\" is required"}
2. [ ] Admins and Reviewers groups should be autocreated if they don't exist. (can we simply check in empty to groups.json?)
3. [ ] Permissions UI is only showing content folder, nothing underneath
4. [ ] When a file is saved and there are no unsaved changes, should Save File be disabled (maybe used to be, now isn't)
5. [ ] When published, no visual indication of status to user. Publish Branch button still there enabled. Change to withdraw?
6. [ ] Content drawer tree always collapsed when opened. Can its expanded folders always include those above the current entry?
7. [ ] User (clerk) data caching, like for 5 mins (keep name and such)
8. [ ] Lambda-friendly initialization storage in memory outside of request
9. [ ] When a user doesn't have access, tell them that instead of showing "no items" messages
10. [ ] Is content navigator filtered by permission?
11. [ ] Final decision on where permissions and groups are stored -- like do we publish them in the normal flow?
12. [ ] YAML as easier way to see MDX? Markdown editors that do MDX?


Bigger not listed in master plan

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


----
Assets uploaded in a branch only visible to that branch
Assets attached to collections
collection has assets.json? alt text, pointer to cloud
Once merged to main, visible to anyone with read access to the collection
when browsing asset manager, see any assets in current collection or higher
upload has hashed filename from content fingerprint, to replicated s3 bucket frontend by cloudfront (assets.safeinsights.org)
images are retrieved via image-cdn images.safeinsights.org/<URL to assets>/instructions
gotta handle PDFs, too. Potentially other file types.
