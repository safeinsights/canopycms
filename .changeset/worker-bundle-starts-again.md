---
'canopycms-cdk': patch
---

### The EC2 worker and GitHub gateway start again — **fix**

<!-- migration
area: Worker
action: None
row: Worker and gateway no longer crash at startup
-->

**What changed.** From 0.12.1 through 0.14.0 the worker bundle failed at load with `Cannot find module './impl/format'`, so the worker and the GitHub gateway exited at startup and systemd restarted them in a loop: no sync, no publish. The bundle now carries all of `jsonc-parser`, and CI starts each bundle this package ships under Node away from any `node_modules`, so a bundle that cannot load fails CI instead of a deployment.

**To adopt.** Upgrade `canopycms-cdk` and deploy as usual; nothing else changes.
