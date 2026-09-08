# Original approved plan: a clearer Plan view with deliberate replanning

The following is the user's implementation request, preserved for review.

## 1. One heading and a clear daily cycle

Use **“Plan today’s flow”** as the single main heading, with the total duration beside it. Remove “Design your flow” and the repeated “Today’s Flow” heading. Keep the existing planning-mode and Compact / Proportional controls.

The bottom bar communicates the current state:

| State | Supporting text | Actions |
|---|---|---|
| Initial planning | “Confirm your order and lock it for today.” | **Lock & focus** |
| Locked | “Order locked · 3 free replans left” | **Replan** and **Back to focus** |
| Replanning | “Changes apply when you confirm.” | **Save order & focus** and **Cancel changes** |
| Free allowance exhausted | “Next confirmed replan: 50 XP” | **Replan** and **Back to focus** |

“Focus” opens Current without starting, resetting, or replacing the timer. Existing overdue and monthly-planning requirements still apply.

## 2. Lock the order, allow unlimited review

- Opening Plan never increments a counter, opens a warning, or deducts XP. Remove the visit-based punishment.
- The first confirmation each day is free and locks the order. Existing confirmed plans become locked with three free replans available; historical visits incur no charge.
- While locked, disable dragging, keyboard reordering, and prioritization that changes today’s order. Keep review, density controls, notes, duration editing, completion, adding tasks, and rescheduling available.
- New tasks enter their existing scheduling-precedence group without changing the relative order of tasks already present. Actions such as promoting an existing task to Frog must enter replanning if they would reorder existing tasks.
- **Replan** opens a draft editing session. Any number of drags or rating adjustments belong to that one session. Changes remain draft-only until confirmation; other devices retain the confirmed order.
- **Cancel changes** discards draft ordering and rating changes. It does not undo independently saved notes, task additions, completions, or rescheduling.
- Count one replan only when confirmation changes the relative order of remaining tasks. Opening a draft, cancelling, returning to the original order, or adding/removing tasks alone consumes nothing.
- Three changed confirmations are free. Subsequent ones cost **50 XP in Classic, 25 XP in Gentle, and 0 XP in Off**. Show the applicable cost before editing and on the confirmation button. Preserve existing XP floor behavior.
- After confirmation, relock and open Current. A new local date receives a fresh allowance. An old-day draft cannot silently become today’s plan.
- Navigating away from a draft preserves it locally. Returning shows **“Unconfirmed order changes”** with Resume and Discard; the draft must not alter Current’s queue before confirmation.

Circadian check-in remains available while locked because it currently does not reorder tasks. Automatic circadian ordering remains deferred.

## 3. Shared persistence and offline behavior

This includes consistent order-lock behavior on **web, Android, and macOS**. The new heading and future-task browser are web UI work.

- Add durable daily policy state: date, confirmed order revision, confirmation history, and accepted replan count. Preserve policy history independently of task completion or existing plan-clearing operations.
- Introduce one idempotent **confirm-order operation** carrying an operation ID, date, baseline revision, proposed order, optional rating changes, and the maximum XP cost the user accepted.
- Commit order changes, policy updates, and any XP debit together. Retries must never consume another allowance or deduct XP twice. Expose the resulting revision, count, and actual debit through existing synchronization.
- Store drafts and pending confirmations durably per account and day. Update native persistence, serialization, backup/restore, and migration coverage alongside the web implementation.
- Offline confirmation remains available and takes effect locally, marked **“Pending sync · allowance provisional.”**
- On reconnect, accept a compatible confirmation once. If another device changed the order, retain both versions and ask the user to keep the synced order or apply their proposed order. Show any applicable cost before applying it.
- Never silently overwrite a newer order or charge more than the user accepted. Pending operations from a previous day retain their original date.
- Preserve task additions and completions during reconciliation; never restore completed tasks merely because an older draft contained them.
- Enforce the policy in shared write paths as well as UI controls. Older clients must not erase counters or bypass the lock through direct order writes; return an update-required response for unsupported ordering operations.

Use additive migrations and preserve existing durable identities. Integrate against the reviewed sync work without overwriting the active checkout’s unrelated changes.

## 4. A bounded Horizon and complete planned-task browser

**On the Horizon**

- Show every task scheduled for tomorrow, followed by the next **three** later tasks in chronological order.
- Retain clear date groups and existing task actions.
- Add **“View planned tasks”** with the total count whenever future tasks exist. Tomorrow remains uncapped, as requested.

**Planned tasks overlay**

- One large dialog on desktop and a full-screen sheet on mobile.
- Sticky header with title, **List / Calendar** switch, and Close. List opens by default; switching views preserves position and selected month.
- List contains all future tasks grouped chronologically, with incremental rendering for large collections and no arbitrary task limit.
- Calendar opens on the current month with previous/next month navigation and **This month**.
- Desktop day cells show up to three task titles and **“+N more.”** Selecting a day opens its complete task list below the grid. Mobile cells use counts and the selected-day list.
- Each today/future day has an accessible Add control: revealed on desktop hover or keyboard focus, always available on touch. It opens the existing task form with that exact day selected.
- Saving or cancelling a task returns to the same calendar month/day or list position.
- Month-only tasks appear under **“No day assigned”** within their month. Never render them as if scheduled on the first day.
- Keep calendar interactions focused on browsing, adding, and existing task editing; no calendar drag-and-drop in this change.
- Support Escape, contained keyboard focus, focus restoration, labelled dates, and nested task forms without losing the underlying view.

## 5. Verification and rollout

- Test unlimited Plan visits; initial locking; three free changed confirmations; fourth-and-later penalties in all settings; cancellation and no-op confirmation.
- Verify every ordering entry point, including keyboard movement and prioritization, respects the lock while permitted edits remain available.
- Test reloads, crashes, account switching, midnight, pending previous-day confirmations, duplicate delivery, simultaneous devices, stale drafts, and offline reconciliation without duplicate XP charges.
- Verify web–Android–macOS convergence using actual clients, including an older client attempting to overwrite policy state.
- Test crowded tomorrow lists, hundreds of future tasks, month-only tasks, leap days, exact-day Add, nested forms, keyboard navigation, and small screens in both themes.
- Deploy shared compatibility support first, then compatible clients, then enable enforcement. Validate on staging before production promotion.
- The existing hosted-sync HTTP 429 failure must be resolved or conclusively isolated before claiming the cross-device feature accepted. Local UI checks alone are insufficient.
