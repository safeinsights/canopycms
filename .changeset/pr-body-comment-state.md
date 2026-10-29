---
'canopycms': patch
---

### Pull request bodies show the editor's open comments

<!-- migration
area: Branches
action: None
row: PR body lists unresolved editor comments
-->

**What changed.** The pull request a submit opens now lists the branch's unresolved editor comment threads: where each one is, the first line of its first comment (80 characters at most) and a link to it in the editor. Once every thread is resolved, it says so. The list is updated whenever a comment is added, replied to or resolved, as well as on submit. Comment excerpts are visible to everyone who can read the pull request, which on a public repository means everyone. Open threads do not block the merge or keep the pull request in draft.
