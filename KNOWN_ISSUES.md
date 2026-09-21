# Known Issues

## 1. User sees past sessions / batteries that are not his ("ghost batteries")

**Status:** Fixed 2026-09-18, re-modeled 2026-09-21 (battery identity removed for rider-deposited batteries). This has regressed before — treat with care.

### Symptom

A rider (e.g. `geokagew`) opens the app and sees old sessions / battery entries
(batteries by uid/id) that belong to other riders — e.g. 7 battery entries that
are not his. The data comes from `GET /api/booths/my-battery-status`
(`controllers/booths/deposit.controller.js`), and stale names used to resurface
in the admin booth/withdrawal queries too.

### The model (2026-09-21)

Slot ownership and physical presence no longer rely on a battery identity:

- **Physical presence** = `booth_slots.status = 'occupied'` (telemetry truth).
  Implies `booth_slots.current_battery_id` MAY be `NULL`.
- **Owner rule** = the latest `completed` deposit on the slot that is:
  - NOT consumed by an active/non-failed withdrawal or rental, AND
  - has no NEWER deposit by a DIFFERENT user that is itself active and
    unconsumed.
- **Battery IDs are reserved for the company's rental batteries.** A rider's
  own deposited battery is tracked with `battery_id = NULL`; the system NEVER
  fabricates a synthetic `bat-*` battery for a personal deposit.

Admin renter/withdrawal queries, `my-battery-status`, `activeBatterySession`
(`routes/auth.js`) and the manual-withdrawal/queries all use the owner rule on
`status = 'occupied'`.

### Why ghosts happened before

1. **`utils/depositReconcile.js` → `reconcileSlotDeposit`** resurrected the most
   recent `failed` deposit on a slot back to `completed` whenever the slot was
   occupied — even if a *newer* completed deposit already owned the slot's
   battery.
2. **`utils/depositReconcile.js` → `ensureSlotBatteryLinked`** backfilled
   `battery_id = current_battery_id` onto **every** deposit session on the slot
   (any status, any user), stamping the new owner's battery id onto old deposits.
3. **`utils/firebaseSync.js` → `handleDepositCompletion`** completed **all**
   matching `opening`/`occupied` deposits on the slot, not just the newest one.

`reconcileSlotDeposit` and `ensureSlotBatteryLinked` run automatically on every
`syncSlotState`, which is why ghosts reappear across many slots at once.

### Guarantees to restore if this regresses

- Only the slot's CURRENT owner deposit may resurface anywhere
  (`reconcileSlotDeposit` resurrection, `ensureSlotBatteryLinked` re-link),
  where "current owner" = latest un-consumed deposit with no newer deposit by
  another user (`d.battery_id IS NULL OR d.battery_id = slot's
  current_battery_id`, gated by the newer-owner check).
- `ensureSlotBatteryLinked` must never fabricate a battery row for a rider
  deposit (`battery_id = NULL` → `{ relinked: false, reason:
  'no_battery_for_personal_deposit' }`); it only re-links an EXISTING battery
  for the current owner deposit.
- `handleDepositCompletion` completes only the newest deposit on the slot (via
  `WHERE id = (SELECT ... ORDER BY d.created_at DESC, d.id DESC LIMIT 1 FOR
  UPDATE)`).
- No deposit/booth/withdrawal query may gate on
  `s.current_battery_id IS NOT NULL` or `d.battery_id = s.current_battery_id`
  for user deposits — presence is `s.status = 'occupied'` and ownership is the
  owner rule. (Rental/placement flows still use battery identity — that is
  correct and untouched.)

### Guardrails / tests

- `tests/renter-name.test.js` — owner-rule selection model + SQL-surface guards
  (occupied guard, newer-owner guard, no battery match).
- `tests/my-battery-status.test.js` — occupied + owner-rule guards on the
  endpoint; asserts no `d.battery_id = s.current_battery_id` match remains.
- `tests/depositReconcile.test.js` — `reconcileSlotDeposit` / 
  `ensureSlotBatteryLinked` never fabricate batteries for rider deposits.
- Keep these guards whenever touching deposit reconciliation, battery backfill,
  deposit completion, or any withdrawal/renter query.

## 2. Rider stuck on "Waiting for Confirmation" after depositing own battery

**Status:** Fixed 2026-09-21. Regression introduced by the same owner-rule
re-model as issue #1 — treat with care.

### Symptom

A rider inserts/secures/locks their own battery (hardware done in ~10s), but the
app spins on "Waiting for Confirmation…" indefinitely. `GET
/api/booths/my-battery-status` returns `null`, so the frontend poll (600ms,
`UserDashboard.tsx`) never advances. Own-battery withdrawal was silently broken
too (same gate).

### Root cause

The owner-rule queries gate physical presence on `booth_slots.status =
'occupied'`, but nothing transitioned a rider-deposit slot out of `'opening'`:

- `initiate-deposit` sets the slot to `'opening'` (`deposit.controller.js`).
- `mapSlotStatus` deliberately keeps `'opening'` while `currentDbStatus ===
  'opening' && batteryInserted` (`firebaseSync.js`), so telemetry alone never
  reaches `'occupied'`.
- `handleDepositCompletion` marked the deposit `completed` but never updated the
  slot. (Before the re-model, queries matched on the fabricated
  `current_battery_id`, which `handleDepositCompletion` did set.)

### Guarantees to restore if this regresses

- `handleDepositCompletion` MUST set the slot to `'occupied'` (guarded
  `WHERE id = $1 AND status = 'opening'`) when it completes a rider deposit —
  never fabricate a battery for it.
- Deposit confirmation must not depend solely on the `deposit_accepted` ACK: a
  telemetry-only fallback finalizes an `'opening'` rider deposit when
  `batteryInserted && doorClosed && doorLocked && plugConnected` (so a missed /
  delayed ACK cannot strand the rider). It must skip rental returns / admin
  placements (they have no `deposit` session to match).
- A late deposit-failure ACK must not downgrade an already-occupied slot: the
  reset is `UPDATE booth_slots SET status = 'available' WHERE id = $1 AND status
  = 'opening'`.
- `POST /initiate-deposit` returns `sessionId` so the client can track the
  exact session while polling.

### Guardrails / tests

- `tests/depositCompletion.test.js` — asserts `handleDepositCompletion` marks
  the slot occupied (guarded to `'opening'`), and source-guards the telemetry
  fallback + failure-reset guard.
- `tests/depositSessionStatus.test.js` — guards the session-status endpoint
  below (user-scoped, terminal states visible).

## 3. Rider stuck on "Waiting for Confirmation" when a deposit is auto-cancelled

**Status:** Fixed 2026-09-21. Same flow as issue #2 — the *failure* half.

### Symptom

The booth auto-cancels a deposit (e.g. `deposit_timeout`, operator cancel,
rejected insert) or is unreachable. The rider stays on "Waiting for
Confirmation…" forever because nothing ever tells them it was cancelled.

### Root cause

`GET /api/booths/my-battery-status` intentionally returns only COMPLETED
deposits, so a `cancelled`/`failed` session yields `null` — indistinguishable
from "still opening". The frontend poll (`UserDashboard.tsx`) only acted on a
non-empty result and silently swallowed fetch errors (`catch {}`), so neither a
server-side cancellation nor a dropped connection ever surfaced.

### Guarantees to restore if this regresses

- `GET /api/booths/deposit-sessions/:sessionId/status` MUST return the caller's
  own session lifecycle (`pending`/`opening`/`completed`/`cancelled`/`failed`/…),
  scoped by `d.id = $1 AND d.user_id = $2` (404 otherwise). It must NOT filter
  on completion — exposing terminal states is the entire point.
- The deposit poll MUST stop and inform the rider on `cancelled`/`failed`
  (return to `home`, or `multi_status` if other batteries remain).
- Repeated poll failures MUST surface a "connection lost" notice (once) while
  continuing to retry; a recovered poll MUST reset the failure/notice state.

### Guardrails / tests

- `tests/depositSessionStatus.test.js` — user scoping + terminal-state visibility.
- `tests/booths.routes.smoke.test.js` — route registration.