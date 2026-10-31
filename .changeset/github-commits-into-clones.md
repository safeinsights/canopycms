---
'canopycms': patch
---

### Commits made on a pull request's branch on GitHub now reach the editor

<!-- migration
area: Branches
action: None
row: Commits made on GitHub reach the editor
-->

**What changed.** After Update branch or a maintainer's fix on GitHub, submitting a branch that had returned to editing failed for good with a 409 saying to try again shortly. Each sync now brings those commits into the branch's workspace, so the submit goes through.

- If both sides changed a file, the editor's version is kept and the pull request lists the file.
- A commit that isn't the base catching up sends an approved branch back to review.
- A branch that has merged GitHub's commits catches up with its base by merging it rather than rebasing, so nothing it settled is undone.
- A branch force-pushed on GitHub is left alone, and nothing more is pushed for it, so a commit removed there stays removed. System health says what a developer needs to do.
- A submit or push GitHub rejects because its branch moved runs again after the next sync, unless the branch has moved on since.

**Rolling back.** Don't roll the worker back past this version once it has run. An older worker rebases editing branches, and a rebase drops the merge commits this one makes: a version kept over GitHub's is replaced by GitHub's, and the result is force-pushed to the pull request. If you have to, first merge or delete every editing branch holding a merge commit, and let the task queue drain.
