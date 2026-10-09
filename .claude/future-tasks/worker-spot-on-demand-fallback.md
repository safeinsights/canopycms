---
priority: P3
adopters: BOTH
summary: >-
  `workerCapacity: { type: 'spot' }` cannot guarantee a worker: an Auto Scaling group has no automatic fallback from spot to on-demand, and with one instance an on-demand base just means on-demand. A real fallback needs extra machinery, such as a second on-demand group woken by failed spot launches.
---
# [P3] Spot worker capacity has no on-demand fallback

**Found:** 2026-10-09, while resolving
[worker-spot-only-capacity.md](resolved/worker-spot-only-capacity.md), which made on-demand the
default and spot an opt-in.

## Problem

The spot opt-in is a mixed-instances policy over `t4g.nano`, `t4g.micro` and `t4g.small`,
price-capacity-optimized, with capacity rebalancing. That makes a shortage less likely but cannot
rule it out: when no pool has capacity, the group keeps retrying and the deployment has no worker.
Auto Scaling has no setting that falls back to on-demand, and `OnDemandBaseCapacity: 1` on a group of
one is simply on-demand.

## Options

- A second, normally empty on-demand group, scaled to 1 by an EventBridge rule on the spot group's
  failed launches and back to 0 when the spot instance is in service. Both instances may run at
  once: the EFS worker lock keeps one worker active.
- Document spot as best-effort and leave it. The default is already on-demand.

Only worth building if an adopter wants spot's saving (about $1.50 a month) and cannot tolerate the gap.
