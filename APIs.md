# APIs

Comprehensive endpoint reference for this project.

## Conventions

- `Path Params`: URL parameters (for example `:id`).
- `Query Params`: URL query keys.
- `Body Params`: JSON body keys unless stated otherwise.
- `-` means no explicit parameters for that location.

## Core

| Method | Endpoint | Path Params | Query Params | Body Params |
|---|---|---|---|---|
| GET | `/` | - | - | - |
| GET | `/admin/log-viewer` | - | - | - |
| GET | `/api/health` | - | - | - |

## Authentication (`/api/auth`)

| Method | Endpoint | Path Params | Query Params | Body Params |
|---|---|---|---|---|
| POST | `/api/auth/register` | - | - | `email`, `password`, `name`, `phoneNumber`, `recaptchaToken` |
| POST | `/api/auth/user-by-phone` | - | - | `phoneNumber` |
| POST | `/api/auth/verify-phone` | - | - | `idToken` |
| POST | `/api/auth/google/sync` | - | - | `uid` |
| POST | `/api/auth/google/complete-profile` | - | - | `uid`, `phoneNumber` or `phone`, `name` |
| GET | `/api/auth/profile` | - | - | - |
| POST | `/api/auth/fcm-token` | - | - | `token` |
| POST | `/api/auth/profile/picture` | - | - | `profileImage` (multipart file field) |

## Booths (`/api/booths`)

| Method | Endpoint | Path Params | Query Params | Body Params |
|---|---|---|---|---|
| GET | `/api/booths` | - | - | - |
| POST | `/api/booths/initiate-deposit` | - | - | `boothUid` |
| GET | `/api/booths/my-battery-status` | - | - | - |
| POST | `/api/booths/stop-charging` | - | - | - |
| POST | `/api/booths/initiate-withdrawal` | - | - | - |
| POST | `/api/booths/sessions/:sessionId/pay` | `sessionId` | - | - |
| GET | `/api/booths/sessions/pending-withdrawal` | - | - | - |
| GET | `/api/booths/withdrawal-status/:checkoutRequestId` | `checkoutRequestId` | - | - |
| POST | `/api/booths/cancel-session` | - | - | - |
| GET | `/api/booths/history` | - | - | - |
| POST | `/api/booths/report-problem` | - | - | `batteryUid`, `boothUid`, `slotIdentifier`, `description` |
| POST | `/api/booths/release-battery` | - | - | `boothUid` |

## Stats (`/api/stats`)

| Method | Endpoint | Path Params | Query Params | Body Params |
|---|---|---|---|---|
| GET | `/api/stats` | - | `scope`, `sessionType`, `days` | - |

## M-Pesa (`/api/mpesa`)

| Method | Endpoint | Path Params | Query Params | Body Params |
|---|---|---|---|---|
| POST | `/api/mpesa/callback` | - | - | M-Pesa callback payload (`Body.stkCallback...`) |

## Admin (`/api/admin`)

| Method | Endpoint | Path Params | Query Params | Body Params |
|---|---|---|---|---|
| POST | `/api/admin/users/set-role` | - | - | `uid`, `newRole` |
| GET | `/api/admin/users` | - | `pageSize`, `pageToken` | - |
| POST | `/api/admin/users/set-status` | - | - | `uid`, `status` |
| DELETE | `/api/admin/users/:uid` | `uid` | - | - |
| GET | `/api/admin/booths` | - | `limit`, `offset` | - |
| GET | `/api/admin/booths/status` | - | - | - |
| POST | `/api/admin/booths` | - | - | `name`, `locationAddress`, `latitude`, `longitude` |
| DELETE | `/api/admin/booths/:boothUid` | `boothUid` | - | - |
| DELETE | `/api/admin/booths/:boothUid/slots/:slotIdentifier` | `boothUid`, `slotIdentifier` | - | - |
| PATCH | `/api/admin/booths/:boothUid` | `boothUid` | - | `name`, `locationAddress` |
| POST | `/api/admin/booths/:boothUid/status` | `boothUid` | - | `status` |
| POST | `/api/admin/booths/:boothUid/slots/:slotIdentifier/status` | `boothUid`, `slotIdentifier` | - | `status` |
| POST | `/api/admin/booths/:boothUid/slots/:slotIdentifier/command` | `boothUid`, `slotIdentifier` | - | Command object keys: `forceLock`, `forceUnlock`, `openForCollection`, `openForDeposit`, `startCharging`, `stopCharging`, `openDoorId` |
| GET | `/api/admin/booths/:boothUid` | `boothUid` | - | - |
| POST | `/api/admin/booths/:boothUid/reset-slots` | `boothUid` | - | `slotIdentifier` (optional) |
| GET | `/api/admin/problem-reports` | - | `status`, `limit`, `offset` | - |
| POST | `/api/admin/problem-reports/:reportId/status` | `reportId` | - | `status` |
| GET | `/api/admin/transactions` | - | `limit`, `offset` | - |
| GET | `/api/admin/settings` | - | - | - |
| POST | `/api/admin/settings` | - | - | settings object (key-value pairs) |
| POST | `/api/admin/simulate/confirm-deposit` | - | - | `boothUid`, `slotIdentifier`, `chargeLevel` |
| POST | `/api/admin/simulate/confirm-payment` | - | - | `checkoutRequestId` |
| GET | `/api/admin/dashboard-summary` | - | `startDate`, `endDate` | - |
| GET | `/api/admin/sessions` | - | `limit`, `offset`, `searchTerm`, `status`, `sessionType`, `startDate`, `endDate`, `slotIdentifier`, `userId`, `sessionId` | - |
| DELETE | `/api/admin/sessions/:sessionId` | `sessionId` | - | - |
| POST | `/api/admin/sessions/cleanup` | - | - | - |
| GET | `/api/admin/payments` | - | `limit`, `offset`, `searchTerm`, `startDate`, `endDate`, `status`, `boothUid`, `sortBy`, `sortOrder` | - |

