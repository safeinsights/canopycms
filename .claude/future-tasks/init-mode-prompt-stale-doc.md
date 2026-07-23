# init README claims an interactive "Operating mode" prompt that no longer exists

**Status**: proposed
**Priority**: P3 (doc/code mismatch — no runtime bug, but misleading)
**Origin**: surfaced while implementing `--auth`/`--dual-build` non-interactive flags for `canopycms init` (2026-07-23, PR-G of the deployment-test epic). Read `packages/canopycms/src/cli/cli.ts` and `README.md`'s Quick Start section side by side while wiring the new flags.

## The mismatch

`README.md`'s Quick Start section (around the `npx canopycms init` example) lists what the CLI "will interactively ask for", including:

> **Operating mode** — `dev` (full local development with branching and git ops) or `prod` (production deployment). This is written into `canopycms.config.ts` as the required `mode` field -- CanopyCMS has no default and refuses to start without it.

But `packages/canopycms/src/cli/cli.ts`'s `init` command handler hardcodes:

```ts
const mode = 'dev'
```

with no prompt, no flag, and no path to `'prod'` at all. `InitOptions.mode` in `packages/canopycms/src/cli/init.ts` is typed as the literal `'dev'` (not `'dev' | 'prod'`), so today `init()` cannot even accept `'prod'` if the CLI tried to pass it.

So either:

1. The CLI/init() never grew prod-mode scaffolding support and the README bullet is describing an aspirational/removed feature, or
2. There's a prod-mode init path that got lost/never wired into `cli.ts`.

## Why it matters

An adopter reading the README and expecting an interactive mode choice will only ever get `dev` written into their generated `canopycms.config.ts` — silently, with no prompt and no error. For a `prod` deployment they'd need to hand-edit `canopycms.config.ts` after the fact, which the README does not mention anywhere in the Quick Start flow.

## Suggested resolution (needs a decision, not just a fix)

- If prod-mode scaffolding is intentionally out of `init`'s scope (adopters hand-edit `mode: 'prod'` post-init, e.g. before running `init-deploy aws`), update the README bullet to say so plainly and drop the "interactively ask" framing for mode.
- If prod-mode scaffolding was intended, add the missing prompt/flag (e.g. `--mode <dev|prod>`) to `cli.ts`, widen `InitOptions.mode` to `'dev' | 'prod'`, and thread it into `canopyCmsConfig()`'s template output.

## Where to look

- `packages/canopycms/src/cli/cli.ts` — `init` command handler (no mode prompt/flag present)
- `packages/canopycms/src/cli/init.ts` — `InitOptions.mode: 'dev'` (literal type, no prod path)
- `README.md` — Quick Start section, "The CLI will interactively ask for" bullet list
- `packages/canopycms/src/cli/init.test.ts` — no test exercises a `'prod'` mode value for `init()`

## Acceptance

- README accurately describes what `canopycms init` actually prompts for and writes today.
- If prod-mode scaffolding is added: `--mode prod` (or equivalent) produces a config with `mode: 'prod'`, with test coverage mirroring the `--auth`/`--dual-build` pattern.
