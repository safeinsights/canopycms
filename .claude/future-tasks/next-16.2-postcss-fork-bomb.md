# Next 16.2.x + PostCSS fork-bomb on adopter dev servers: upstream issue not filed

**Priority: P3 [BOTH].** The package-level mitigation is in place. `canopycms-next`'s `next` peer range
is `^13.5.7 || ^14.2.25 || ^15.5.21 || >=16.0.0 <16.2.0 || >=16.3.0 <17.0.0`, README's Requirements
section carries a "Known-bad version: Next 16.2.x" subsection, and `docs/deploying-to-aws.md`'s
Prerequisites point at it. `>=16.3.0` is allowed because the regression is bisected in 16.2.x only
and not re-verified in later releases.

## What remains

Reproduce in a minimal repo and file or find the upstream Next.js issue; nobody has. Then re-check
16.3.x and drop the exclusion if it is fixed.

## Symptom and reproduction

`next dev --turbopack` on 16.2.4 boots normally, logs `Compiling /`, then the Node process tree
fork-bombs (hundreds of `node` processes within seconds, count following 2^n - 1). Reproduces with a
PostCSS config that resolves plugins (`postcss-preset-mantine` + `postcss-simple-vars`) and **any** CSS
import from `app/layout.tsx`, including a plain 20-line reset. Removing every CSS import stops it;
removing `withCanopy`, Mantine components, `next/font/google` or the Mantine provider does not. Not
reproduced on 16.1.7 with the same tree. Likely a Turbopack regression in PostCSS plugin loading or
a worker pool that retries recursively on unresolved plugins.

Adopters pin `next` to `~16.1.6` meanwhile.
