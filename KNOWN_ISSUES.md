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