---
'canopycms': patch
---

### Pull request bodies show the editor's open comments

<!-- migration
area: Branches
action: Optional
row: PR body lists unresolved editor comments
-->

**What changed.** The pull request a submit opens now lists the branch's unresolved editor comment threads: where each one is, the first line of its first comment (80 characters at most) and a link to it in the editor. Once every thread is resolved, it says so. The list is updated whenever a comment is added, replied to or resolved, as well as on submit. Comment excerpts are visible to everyone who can read the pull request, which on a public repository means everyone. Open threads do not block the merge or keep the pull request in draft. A pull request opened before this release shows no list until its branch is next submitted.

**To adopt.** Nothing, if your deploy replaces the worker along with the CMS, as `cdk deploy` of the canopycms-cdk stack does with the default `workerCode`. A worker on an earlier release fails each update of the list and marks the branch's sync failed until a later task succeeds, so a pipeline that leaves the worker behind must roll it no later than the CMS: see [Rolling the worker from CI](../docs/deploying-to-aws.md#rolling-the-worker-from-ci).
