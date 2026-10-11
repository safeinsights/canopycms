---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-11, from the security round of the worker process split's PR 6. `canopy-inspect --interactive` gives the operator a pty that systemd chowns to uid 1000, in the /dev/pts the worker unit also sees (PrivateDevices bind-mounts the host's). A compromised worker can read and write that pty: it can race the inner shell for keystrokes and write escape sequences to the operator's terminal. It cannot inject commands, and it reaches no secret. Decide between saying so in the docs and running the inspect sandbox as a separate uid.
---

# [P3] canopy-inspect's interactive pty is reachable from the worker unit

**Found:** 2026-10-11, the Fable security round on PR 6 of
[worker-shared-repo-git-process-split.md](worker-shared-repo-git-process-split.md) (its R9).

`systemd-run --pty --uid=ec2-user` makes systemd chown the pty slave to uid 1000 (0620, group tty)
before exec. `PrivateDevices=yes` gives the worker unit a private `/dev`, but bind-mounts the
host's `/dev/pts` into it. So the worker (uid 1000) can open `/dev/pts/N` of an operator's
`canopy-inspect --interactive` session:

- it can `read()` keystrokes meant for the inner shell, racing it;
- it can write bytes that reach the operator's terminal emulator, which is the escape-sequence class
  the wrapper already warns about.

It cannot use TIOCSTI: the pty is not its controlling tty, and it has no CAP_SYS_ADMIN on kernel
6.1. It cannot write to the master either, which root's systemd-run holds. The default `--pipe`
mode is unaffected.

What an operator types into that shell is not a secret: it is uid 1000 inside the worker's sandbox.

Options:
1. Document that the interactive mode is exactly as trusted as the worker, and prefer one-shot
   commands. This belongs in PR 7's `canopy-inspect` docs.
2. Run the inspect sandbox as a dedicated uid. The pty would then not be uid 1000's, but writes to
   EFS still need uid 1000 (an access point, or group write), which is why this is not done now.
   It overlaps [worker-dedicated-user.md](worker-dedicated-user.md).
