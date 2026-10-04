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

## Round 3 LOWs (review at 7b2beff7, 2026-09-13)

Round 3's two MEDIUMs are being fixed on `fix/worker-credential-epic-review-final`, as the
maintainer decided. The retry prompt now accepts a file path only, and a destination command
reads the key from a real pipe bridged through `sh`, not a socket. These four LOWs are filed.

### 5. Text then Ctrl-D twice at the retry prompt skips the install wait

Since round 2's fix, a line ended by EOF marks stdin as ended. That is correct, but if the line
was a good path, the key is stored and `pressEnter('Press Enter once it is installed.')` then
returns at once. The readback runs before anyone could install the App and exits 1 with "No
installation … (HTTP 404)". The reviewer confirmed this on a pty. Item 3's proposed remedy,
re-asking after an empty readback, cannot help, because stdin has ended. Say so in the output
instead: "stdin closed — install the App, then run `verify`".

### 6. Origin detection misreads a `host:port` remote and accepts look-alike hosts

`detectGitHubRepo` (`packages/canopycms/src/cli/project-detect.ts`, shared with `init-deploy`)
mis-parses two remotes the reviewer ran:

- `ssh://git@ssh.github.com:443/acme/site.git` (GitHub's documented SSH-over-443 form) and
  `https://github.com:443/acme/site.git` both parse as owner `443`, repo `acme/site`.
- `https://notgithub.com/acme/site.git` parses as github.com `acme/site`.

### 7. `create` accepts an empty name and an `owner/repo` value for `--repo`

- **Empty name.** A bare `--name` followed by another flag parses as `""`, so the slug is empty,
  `checkNameAvailable` requests `/apps/`, and the manifest goes out nameless. A whitespace-only or
  emoji-only name also produces an empty slug.
- **`owner/repo` in `--repo`.** `--repo acme/site` builds the manifest URL
  `https://github.com/acme/acme/site`, and the readback path can never match. The App gets
  created, and every readback fails.

### 8. A rate-limited account-type lookup blocks `create` with no override

The unauthenticated `GET /users/{owner}` is limited to 60 requests an hour per IP. A 403 makes
`detectAccountType` return `null` and discard GitHub's message, and `create` exits with "Check
the name and your network". There is no flag to state user or organisation, although
`resolveTarget` already exempts `verify` from this lookup for exactly that reason.

## From the post-merge review of #331 (2026-09-13)

### 9. `init`'s `.gitignore` block does not ignore `*.pem`

`CANOPY_GITIGNORE_BLOCK` in `packages/canopycms/src/cli/init.ts` adds only `.canopy-dev/`, so a key that `create --key-out` wrote inside the project is one `git add .` from being committed. The generated `.dockerignore` gained `**/*.pem` in that review; its `.env*` line still matches only at the context root, the root-only matching measured there on Docker 29.6.2.
