# System Criteria

This document defines the operational rules and constraints for the RiderCMS battery swap service, specifically focusing on session management and administrative control.

## 1. Session Management & Cancellation Logic

Sessions track the interaction between a user and a booth slot for both deposits and withdrawals.

### Cancellation Rules

Users can cancel their own active sessions via the `/api/booths/cancel-session` endpoint, subject to the following rules:

* **Eligible States:** Only sessions with the status `pending`, `opening`, or `in_progress` can be cancelled.
* **Withdrawal Lock:** A session of type `withdrawal` **cannot** be cancelled if its status is `in_progress`. In this context, `in_progress` indicates that payment has been confirmed via M-Pesa. Once paid, the user must complete the collection.
* **Targeting:** The body may carry `sessionId` to cancel exactly that session (unknown id → `404`; already cancelled → `200`; completed/redeemed/manual → `409`). Without it the endpoint cancels, in order: the newest `deposit` in `pending`/`opening`, then an unpaid `withdrawal`, then an uncollected `rental`. The choice is deterministic and the row is locked.
* **Rental Lock:** A `rental` that is `in_progress` (out with the rider) can never be cancelled here; it is returned and billed instead (`409`).
* **Slot Recovery:** Upon successful cancellation of a `deposit` or `rental`, the associated booth slot is immediately returned to the `available` status. A `withdrawal` never reserved a slot (the rider's battery is still inside), so its slot is left untouched. Pending hardware commands (like `openForDeposit`) are cleared in Firebase in every case.

### Payment Safety

* `POST /api/booths/sessions/:id/pay` and `POST /api/booths/rentals/:id/pay` lock the session row. If an STK push was sent within `MPESA_PENDING_TIMEOUT_SECONDS + 30` seconds they answer `409` with the existing `checkoutRequestId` instead of sending another prompt.
* If the earlier push is older, M-Pesa is asked first; a push that was in fact paid is completed (`200`, `paymentStatus: 'paid'`) rather than charged again.
* The payer number is the token's `phone_number`, falling back to `users.phone`; with neither, the endpoint answers `400`.
* A failed or cancelled STK push (`/api/mpesa/callback` with a non-zero `ResultCode`) marks the session `failed`, matched on the exact `mpesa_checkout_id`: a withdrawal waiting as `pending`, or a rental waiting as `in_progress`. A failure for an older push therefore cannot affect a session that already has a newer one.
* Sending a new rental prompt always sets the rental back to `in_progress`, because the callback, the status endpoint and `completePaidRental` all key on that state. Without it, a retry after a failure would show as failed and a successful payment would not complete the rental.

## 2. Administrative Command Rules

Administrative commands sent via `/api/admin/booths/:boothUid/slots/:slotIdentifier/command` are subject to strict validation to ensure hardware safety and data integrity.

### Command Whitelist

Only the following properties are permitted in a command payload:

* `forceLock`, `forceUnlock`: Manual door locking/unlocking.
* `openForCollection`, `openForDeposit`: Workflow-specific door triggers.
* `startCharging`, `stopCharging`: Manual relay control.
* `openDoorId`: Unique identifier for triggering specific door actions.

### Mutual Exclusivity

To prevent hardware conflicts, the system enforces mutual exclusivity for certain command pairs:

* If `forceLock` is enabled, `forceUnlock` is automatically disabled (and vice versa).
* If `startCharging` is enabled, `stopCharging` is automatically disabled (and vice versa).

### Manual Relay Control (Charging)

The following rules apply when an admin attempts to manually control a slot's charging relay:

#### 1. Start Charging Requirements

The `startCharging` command is subject to pre-flight database validation and post-sync revocation logic:

1. **Slot Health:** The slot must not be marked as `disabled` or `faulty`.
2. **Battery Presence & Session Validation:** A battery must be physically present (as per telemetry) AND there must be an active or completed `deposit` session record for that slot. This ensures the battery is legally in the system's custody.
3. **Session Validation:** There must be an active or completed `deposit` session record for that slot. This serves as the primary verification of battery presence and custody while explicit battery UID registration is not yet mandatory.
4. **Automatic Revocation:** If a `startCharging` command is detected in Firebase but the database status is `disabled` or `faulty`, the system will proactively clear the command and set the `ack` to `rejected_policy_state`.

#### 2. Stop Charging Requirements

* **Whitelist Verification:** Only valid admin users can issue this command.
* **Mutual Exclusivity:** Sending `stopCharging: true` automatically forces `startCharging` to `false` in the payload sent to the hardware.

## 3. Concurrency & Race Condition Prevention

To prevent multiple users from being assigned the same booth slot simultaneously:

* **Atomic Reservation:** The system uses SQL `UPDATE ... WHERE status = 'available'` to ensure that only one transaction can successfully claim a slot.
* **Opening State Protection:** Once a slot enters the `opening` state, the `firebaseSync` logic is forbidden from reverting the status to `available` based on "empty" telemetry. The slot remains locked until either a battery is detected or a timeout/cancellation occurs.
* **Per-User Serialization:** Users are locked at the database level during session initiation to prevent a single account from spawning multiple concurrent sessions via rapid UI taps.

### 3. Data Inconsistency Handling

The system actively monitors for discrepancies between physical hardware state (Firebase telemetry) and the logical state in the PostgreSQL database.

#### Battery Present, No Session

If Firebase telemetry reports a battery is physically present in a slot (`telemetry.batteryInserted = true`), but the PostgreSQL database has no corresponding active or completed `deposit` session for that slot:

* The slot's status in PostgreSQL will be automatically updated to `faulty`.
* Any active `startCharging` or `stopCharging` commands in Firebase for that slot will be cleared, and the `ack` will be set to `rejected_no_session`. This prevents charging an unregistered battery and flags the slot for administrative review.

## 5. M-Pesa Data Reconciliation

To ensure financial accuracy when Safaricom callbacks are missing metadata:

* **Missing Data Flagging:** If a successful callback (`ResultCode: 0`) arrives without a Receipt Number or Amount, the system records these as "N/A" in the `mpesa_callbacks` audit log.
* **Daily Reconciliation:** A background process runs every 24 hours at 2 AM to identify all "N/A" entries. It uses a 48-hour lookback window to provide redundancy in case of external API downtime.
* **Status Querying:** For each identified entry, the system calls the M-Pesa `querySTKStatus` API using the `CheckoutRequestID`.
* **Correction:** If the API query returns the missing metadata, the `mpesa_callbacks` record and any associated session notes are updated with the actual values.
* **Verification:** This process prevents "ghost" successful transactions that lack a verifiable audit trail.

## 6. Data Retention & Automated Cleanup

To maintain database performance and resolve stuck sessions:

* **Cancelled Sessions:** Sessions marked as `cancelled` are automatically purged from the database after **30 days**.
* **Stuck Withdrawals:** Withdrawal sessions that remain `in_progress` (paid but not collected) for more than **5 minutes** are subject to automated resolution. The system will attempt to auto-complete these sessions to release the user from the active session lock.
* **Stale Pending Deposits:** Any `pending` deposit sessions that are superseded by a new request from the same user are automatically cancelled and their slots released.

---
*Last Updated: Based on ridercmsV1 controller logic.*
