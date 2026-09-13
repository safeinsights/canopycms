# [P3] `init-github-app` LOW findings from the worker-credential epic's review

Found 2026-09-13 by review round 1 of the worker-credential epic, in PR #333's CLI. The two
MEDIUMs from the same round were fixed on `fix/init-github-app-retry-prompt`: a stray Enter
giving up the key, and a one-word answer writing the key into the working directory. These are
the LOWs, filed rather than fixed so the review converges.

## 1. Ctrl-C during the key hand-off loses the key

`createCommand` installs no SIGINT handling. The destination command shares the terminal's
process group, so Ctrl-C kills both it and node. A destination command stuck on the network — or
the retry prompt itself — can only be escaped that way. The key is lost, the "Stopping here"
block with the App id is never printed, and the `finally` that removes the `canopycms-app-*`
form directory is skipped. That directory holds no secret, only the manifest, `state` and port.

Confirmed by the reviewer in a pty harness: `-- sleep 30`, then Ctrl-C; the process exited 130
and left the directory behind.

## 2. A failed manifest conversion is never retried, and its status is discarded

`convertManifest` collapses every failure — status 0 (DNS or a timeout), 5xx, 404, 422 — to
`null`. The operator is then told to generate a key by hand. GitHub's conversion code stays valid
for an hour, so retrying a transient failure GitHub never processed would recover the key with
no extra step. The operator is also never told which kind of failure it was.

## 3. A buffered Enter makes the install check run before anyone has installed the App

This is the same typeahead mechanism as the fixed MEDIUM. An Enter pressed before
`pressEnter('Press Enter once it is installed.')` makes that prompt return at once, so the
readback reports "No installation" and exits 1. The key has already been stored, so this is
advisory only. A fix would re-ask after a readback finds no installation.

## 4. The drift test's call-site backstop misses realistic shapes

In `packages/canopycms/src/cli/github-app-permission-drift.test.ts`, `OCTOKIT_CALL` misses all
of these, per the reviewer's probe with the regex and stripper copied verbatim:

- `const gh = ctx.octokit(); gh.pulls.create(`
- `octokit.graphql<T>(`
- `octokit?.pulls…`
- `octokit['pulls']…`
- a client variable not named `octokit`

The comment stripper (`withoutComments`) also starts a block comment inside a string such as
`'content/*'`, and treats `//` inside a URL string as a line comment, so it can swallow code. The
behavioural half of that test still covers the three files that call GitHub today; the backstop
exists to catch a fourth.
