# RiderCMS — collectionpay-service

Battery swapping backend API with M-Pesa payment integration and Firebase Realtime Database sync.

## Architecture

| Layer | Tech |
|---|---|
| Runtime | Node.js / Express |
| Database | PostgreSQL (persistent state) |
| Realtime | Firebase Realtime Database (hardware telemetry, commands) |
| Payments | Safaricom M-Pesa STK Push (sandbox) |

## Key Files

| File | Purpose |
|---|---|
| `server.js` | Express app entry point |
| `controllers/booths/deposit.controller.js` | Deposit initiation, battery status |
| `controllers/booths/withdrawal.controller.js` | Stop charging, withdrawal, payment, release |
| `controllers/admin/booths.controller.js` | Admin: send commands to slots, manage booths |
| `utils/firebaseSync.js` | Syncs Firebase telemetry -> PostgreSQL; handles hardware ACKs |
| `utils/mpesa.js` | M-Pesa STK push, status query, B2C payout |
| `routes/mpesa.js` | M-Pesa callback webhook handler |
| `utils/sessionUtils.js` | `completePaidWithdrawal()` — payment confirmation logic |
| `utils/cron-functions/hardware-cron.js` | Charging conditions check, stuck withdrawal resolution, weekly cleanup |
| `db/init.js` | Database schema initialization |
| `System_Criteria.md` | Operational rules and constraints |

## Flow

### Deposit
1. User requests deposit → `POST /api/booths/initiate-deposit` (sends `{ boothUid }`)
2. System finds available slot (DB `status = 'available'`, no telemetry `batteryInserted`)
3. Slot atomically reserved (`available` → `opening`), command `{ openForDeposit: true }` sent to Firebase
4. Hardware opens door, user inserts battery, door closes
5. Hardware sends `ack: "deposit_accepted"` → `firebaseSync.js` marks session `completed`, sends `{ startCharging: true }`

### Withdrawal & Payment
1. User checks batteries → `GET /api/booths/my-battery-status` (returns array with `sessionId`)
2. User picks a battery → `POST /api/booths/stop-charging`
3. Wait → `POST /api/booths/initiate-withdrawal` (optional body `{ sessionId }` targets specific deposit)
4. Pay → `POST /api/booths/sessions/:sessionId/pay` (initiates M-Pesa STK push)
5. M-Pesa callback → session moves `pending` → `in_progress`, user gets push notification
6. User scans booth QR → `POST /api/booths/release-battery` → hardware opens door
7. Hardware sends `ack: "collection_complete"` → session `completed`, deposit credit `redeemed`

## Booth Occupancy

A booth is fully occupied (no slots available for deposit) when **every slot** fails at least one check:

1. **Database status** — slot must be `available` (not `occupied`, `opening`, `faulty`, `maintenance`, or `disabled`)
2. **Firebase telemetry** — if DB says `available` but hardware reports `batteryInserted && plugConnected`, the slot is skipped (inconsistency guard)
3. **Atomic reservation** — even if eligible, another concurrent request may have already claimed the slot

## M-Pesa Callbacks & Self-Healing

- Callback URL: `POST /api/mpesa/callback` (configurable via `MPESA_BASE_URL`)
- `withdrawal-status/:checkoutRequestId` — polling endpoint with self-healing (queries M-Pesa after 80s timeout)
- `resolveStuckWithdrawals()` cron — runs every 90s, auto-completes `in_progress` withdrawals stuck > 5 minutes
- `runWeeklyMaintenance()` — purges cancelled sessions > 30 days (Sundays 3 AM)
- `runMpesaReconciliation()` — daily at 2 AM, recovers missing receipt numbers

## Environment Variables

See `.env` for the full list. Key ones:

| Variable | Description |
|---|---|
| `MPESA_CONSUMER_KEY/SECRET` | Safaricom API credentials |
| `MPESA_PASSKEY` | STK push passkey |
| `MPESA_SHORTCODE` | Till number |
| `MPESA_BASE_URL` | Public URL for M-Pesa callback |
| `FIREBASE_*` | Firebase Admin SDK credentials |
| `DATABASE_URL` | PostgreSQL connection string |

## Setup

```bash
npm install
# Edit .env with your credentials
node server.js
```

## Deploy

```bash
gcloud run deploy collectionpay-service --source . --region europe-west1 --project ridercms-ced94
```
