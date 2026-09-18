# Known Issues

## 1. User sees past sessions / batteries that are not his ("ghost batteries")

**Status:** Fixed 2026-09-18. This has regressed before — treat with care.

### Symptom

A rider (e.g. `geokagew`) opens the app and sees old sessions / battery entries
(batteries by uid/id) that belong to other riders — e.g. 7 battery entries that
are not his. The data comes from `GET /api/booths/my-battery-status`
(`controllers/booths/deposit.controller.js`).

### Why it happens

`my-battery-status` is intentionally strict: a rider only sees a battery when
ALL of these hold:

- the deposit is `completed`
- it is NOT consumed by an active/non-failed withdrawal
- `d.battery_id = s.current_battery_id` (the deposit's battery matches the
  battery physically in the slot)

That strict battery uid/id match was the original fix (see guards + tests in
`tests/my-battery-status.test.js`). The bug came back because the self-healing
layers added later broke those invariants and stamped a NEW user's battery
uid/id onto OLD deposits:

1. **`utils/depositReconcile.js` → `reconcileSlotDeposit`** resurrects the most
   recent `failed` deposit on a slot back to `completed` whenever the slot is
   occupied — even if a *newer* completed deposit already owns the slot's
   battery.
2. **`utils/depositReconcile.js` → `ensureSlotBatteryLinked`** backfilled
   `battery_id = current_battery_id` onto **every** deposit session on the
   slot (any status, any user), so old NULL-`battery_id` deposits got the new
   owner's battery id and then matched the strict guard.
3. **`utils/firebaseSync.js` → `handleDepositCompletion`** completed **all**
   matching `opening`/`occupied` deposits on the slot, not just the newest one
   — so a stale deposit from another user could be completed.

`reconcileSlotDeposit` and `ensureSlotBatteryLinked` run automatically on every
`syncSlotState`, which is why ghosts reappear across many slots at once.

### The fix (what to restore if it regresses)

- `reconcileSlotDeposit`: only resurrect a `failed` deposit if it is STILL the
  slot's owner —
  - `d.battery_id IS NULL OR d.battery_id = slot's current_battery_id`, and
  - there is NO newer completed, unconsumed deposit on the slot
  (so an older rider's deposit is never revived once a new rider's battery is
  in the slot).
- `ensureSlotBatteryLinked`: the `battery_id` backfill only re-links the
  current owner deposit — most recent, unconsumed, and in
  `('opening', 'in_progress', 'completed')` — never every deposit on the slot.
- `handleDepositCompletion`: completes only the newest deposit on the slot
  (via `WHERE id = (SELECT ... ORDER BY d.created_at DESC, d.id DESC LIMIT 1
  FOR UPDATE)`).

### Guardrails / tests

- `tests/depositReconcile.test.js` — `selectResurrectCandidate` (mirrors the
  reconcile SQL) + `ghost-battery resurrection guard` block.
- `tests/my-battery-status.test.js` — the strict battery-present/uid match
  guards on the endpoint.
- Keep these guards whenever touching deposit reconciliation, battery backfill,
  or deposit completion. Do not "loosen" the battery match to be NULL-tolerant
  in `my-battery-status` (the admin renter queries are deliberately
  different).