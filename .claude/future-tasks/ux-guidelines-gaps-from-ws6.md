---
priority: P3
adopters: NEITHER
summary: >-
  docs/ux-guidelines.md is silent on eight things the WS6-lite and phase-2 review fixes had to decide: which primary action a card shows when one card serves both editor and reviewer; that a disabled control's reason Tooltip must also open on focus (Mantine's default is hover only); whether disabled menu items stay focusable with the reason inline; whether a command that only opens a confirm takes "…"; how "Create branch" (a form's confirm) and a card's "Open" fit the vocabulary table; where focus goes when an action removes the focused item from a list; where focus returns when the opener is gone or one overlay replaced another; and where focus goes when an overlay's action navigates to new content.
---

# UX guideline gaps surfaced by WS6-lite

## What WS6-lite decided (so the guideline can confirm or overrule)

- Reviewer on someone else's submitted branch: Request changes is the card's primary action.
- Disabled-with-reason Tooltips open on hover, focus and touch.
- Disabled menu items keep `aria-disabled` (not `disabled`) so arrow keys reach them, with the
  reason as a second line in the item.
- Submit for review, Withdraw from review and Delete branch open confirms and take no "…";
  "New branch…", "Switch branch…" and "Reply…" ask for more and do.
- A branch card's button says "Open"; the create form's confirm says "Create branch".
- Resolving a thread that leaves a list moves focus to the list's count heading; one that stays
  moves focus to its own heading; either only when the user hasn't moved focus since clicking
  Resolve.
- An overlay whose opener has unmounted, or that replaced another overlay (navigator drawer, then
  quick-open palette), returns focus to the nearest opener still on screen: the breadcrumb button
  that opened the drawer, else the header's file dropdown. A return happens only when the user
  hasn't moved focus elsewhere.
- Picking an entry from the drawer or palette returns focus to that control, which names the new
  entry, rather than moving it into the form.

## Done when

Each point is either written into docs/ux-guidelines.md or recorded as a deliberate omission.
