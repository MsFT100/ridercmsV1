# RiderCMS — collectionpay-service

Battery swapping backend API with M-Pesa payment integration and Firebase Realtime Database sync.

## Architecture

| Layer | Tech |
|---|---|
| Runtime | Node.js / Express |
| Database | PostgreSQL (persistent state) |
| Realtime | Firebase Realtime Database (hardware telemetry, commands) |
| Payments | Safaricom M-Pesa STK Push |

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

## Admin Endpoints

All admin routes are under `/api/admin/booths` and require a Firebase auth token with the `admin` role.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/booths` | List all booths (paginated, with slot/battery/user info) |
| `GET` | `/booths/status` | Real-time status of all booths (merges Firebase telemetry) |
| `GET` | `/booths/:boothUid` | Details of a single booth with its slots |
| `GET` | `/booths/:boothUid/slots/:slotIdentifier` | Detailed slot info with active session and real-time Firebase data |
| `POST` | `/booths` | Create a new booth (name, locationAddress required) |
| `PATCH` | `/booths/:boothUid` | Update booth metadata (name, locationAddress, latitude, longitude) |
| `DELETE` | `/booths/:boothUid` | Delete a booth and all its slots |
| `DELETE` | `/booths/:boothUid/slots/:slotIdentifier` | Delete a single slot |
| `POST` | `/booths/:boothUid/status` | Set booth status: `online`, `maintenance`, `offline` |
| `POST` | `/booths/:boothUid/slots/:slotIdentifier/status` | Set slot status: `available`, `disabled` |
| `POST` | `/booths/:boothUid/slots/:slotIdentifier/command` | Send a command to a slot (see below) |
| `POST` | `/booths/:boothUid/reset-slots` | Reset one or all slots to factory defaults |
| `POST` | `/booths/:boothUid/slots/:slotIdentifier/manual-withdraw` | Manually withdraw a battery (stop charge, create completed withdrawal, release door) |

### Slot Commands

Send any combination of these boolean flags to `POST /booths/:boothUid/slots/:slotIdentifier/command`:

| Command | Description |
|---------|-------------|
| `forceLock` | Physically lock the slot door. Clears `forceUnlock`. |
| `forceUnlock` | Physically unlock the slot door. Auto-completes any stuck withdrawal session and resets the slot to `available`. Clears `forceLock`. |
| `openForDeposit` | Open door for battery insertion |
| `openForCollection` | Open door for battery removal |
| `startCharging` | Begin charging the battery. Blocked if slot is `disabled`/`faulty` or has no active deposit session. Clears `stopCharging`. |
| `stopCharging` | Stop charging. Clears `startCharging`. |
| `openDoorId` | A string value used to trigger an open action with a unique identifier |

**Example:**
```json
{ "forceUnlock": true }
```

## Developer Isolation (PostgreSQL Schema)

The system isolates frontend development from production data using a separate **`dev` PostgreSQL schema**. When a user has the `developer` role, all their queries automatically target the `dev` schema instead of `public`.

### How it works

| Component | Production (`public`) | Developer (`dev`) |
|---|---|---|
| Firebase Auth | Same project, `role: user\|admin` | Same project, `role: developer` |
| PostgreSQL | `public.users`, `public.booths`, etc. | `dev.users`, `dev.booths`, etc. |
| M-Pesa | Real STK push | Auto-approved (no payment) |
| Firebase hardware commands | Sent to real hardware | Auto-simulated |

The schema is selected via `AsyncLocalStorage` — zero changes needed to the 272+ query calls across the codebase.

### Setup

```bash
# 1. Start the server at least once to create the dev schema tables
npm run dev

# 2. Seed the dev environment (Firebase user + virtual data)
npm run seed:dev
```

### Developer Credentials

```
Email:    dev@ridercms.test
Password: Maxtek2020
Role:     developer
```

> **Note:** Firebase custom claims take a few minutes to propagate. If login returns "User profile not found," wait and try again. The profile endpoint auto-falls back to the `dev` schema.

### Virtual Booth Simulation

Two virtual booths are seeded in the `dev` schema. Booth UIDs starting with `dev-` trigger automatic simulation — no real hardware or M-Pesa is needed.

| Booth UID | Slots | Batteries |
|---|---|---|
| `dev-booth-alpha` | A1, A2, A3, A4 | 5 virtual batteries |
| `dev-booth-beta` | B1, B2, B3, B4 | (shared pool) |

### Full Developer Walkthrough

The developer can test the complete user flow without real hardware or payments:

| Step | Endpoint | Dev Behavior |
|---|---|---|
| 1. List booths | `GET /api/booths` | Shows both virtual booths |
| 2. Initiate deposit | `POST /api/booths/initiate-deposit` | Auto-assigns battery, completes instantly |
| 3. Check battery | `GET /api/booths/my-battery-status` | Shows deposited battery from DB |
| 4. Stop charging | `POST /api/booths/stop-charging` | Reports relay already off |
| 5. Initiate withdrawal | `POST /api/booths/initiate-withdrawal` | Creates withdrawal session |
| 6. Pay | `POST /api/booths/sessions/:sessionId/pay` | Auto-approved, no M-Pesa call |
| 7. Release battery | `POST /api/booths/release-battery` | Marks session complete, frees slot |

### Architecture

```
Request → schemaRouter (ALS: 'public')
       → verifyFirebaseToken
           ├── role === 'developer'  → ALS: 'dev'  +  req.schema = 'dev'
           └── role !== 'developer'  → ALS: 'public' +  req.schema = 'public'
       → pool.connect(req.schema)
           └── SET search_path TO <schema>
               └── Query resolves to correct schema tables
```

### Background jobs (unaffected)

`firebaseSync.js`, `hardware-cron.js`, and `reconciliationWorker.js` run outside HTTP request context and always target the `public` schema.

### New / Modified Files

| File | Purpose |
|---|---|
| `utils/schemaStorage.js` | AsyncLocalStorage instance for per-request schema context |
| `middleware/schemaRouter.js` | Express middleware wrapping each request in ALS context |
| `scripts/seed-dev.js` | Seeds Firebase Auth user + dev schema with virtual data |
| `db/index.js` | Monkey-patches `pool.connect()` to set `search_path` from ALS |
| `db/init.js` | Creates `dev` schema with mirrored tables on startup |
| `middleware/auth.js` | Sets `req.schema` and ALS context based on `role` claim |
| `controllers/booths/shared.js` | Exports `isDevBooth()` helper |
| `controllers/booths/deposit.controller.js` | Simulates deposit for `dev-` booths |
| `controllers/booths/withdrawal.controller.js` | Simulates stop-charging and release for `dev-` booths, skips M-Pesa |

## Deploy

```bash
gcloud run deploy collectionpay-service --source . --region europe-west1 --project ridercms-ced94
```
