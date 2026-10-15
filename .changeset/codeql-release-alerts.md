---
'canopycms': patch
---

### Linear-time mount paths and push refusals, and no thrown text across the gateway — **security fix**

<!-- migration
area: Worker
action: None
row: Linear-time parsing; gateway sends a fixed message for non-Errors
-->

**What changed.** The AI export trims slashes from `AIContentConfig.mountPath`, and the worker
recognises GitHub's refusal of a workflow push, in time linear in their length; a long run of
slashes or a repeated phrase took seconds before. When the GitHub gateway fails with a thrown value
that is not an `Error`, the worker gets a fixed message and the gateway's log gets the value, which
could hold a stack.
