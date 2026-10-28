---
'canopycms-cdk': patch
'canopycms': patch
---

### An alarm for a running worker whose git syncs all fail

<!-- migration
area: Ops
action: None
row: alarmTopic also notified when syncs fail for an hour
-->

**What changed.** The worker-down alarm counts the line every git-sync cycle logs before it starts, so a running worker whose every sync failed stayed green. The worker now also logs `Git sync complete` when a cycle runs to its end. With `alarmTopic` set, `CanopyCmsService` adds `workerSyncFailingAlarm`, which notifies the topic, and again on recovery, when cycles keep starting and none completes for 60 minutes. A GitHub outage is the usual cause, and the alarm's description says to check GitHub's status first.

**To adopt.** Nothing, in the default asset mode. With `workerCode: { source: 'parameter' }`, roll the bundle within the hour of deploying the template: an older bundle never logs `Git sync complete`, so the alarm fires until it rolls.
