---
'canopycms': patch
---

### Linear-time mount paths and push refusals, and a fixed message for non-Error gateway failures — **security fix**

<!-- migration
area: Worker
action: None
row: Linear-time parsing; gateway sends a fixed message for non-Errors
-->

**What changed.** The AI export trims slashes from `AIContentConfig.mountPath`, and the worker
and its GitHub gateway recognise GitHub's refusal of a workflow push, in time linear in their
length; a long run of slashes or a repeated phrase took seconds before. When the gateway fails with
a thrown value that is not an `Error`, the worker gets a fixed message and the gateway's log gets
the value, scrubbed and capped, since it could hold a stack.
