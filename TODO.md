# TODO

## M-Pesa callback: enforce the IP whitelist

**Status:** deferred (decided 2026-10-27).

`POST /api/mpesa/callback` (`routes/mpesa.js`) only checks the caller's IP when
`MPESA_WHITELISTED_IPS` is set **and** `NODE_ENV === 'production'`. With the
variable unset, the endpoint is public: anyone who knows a `CheckoutRequestID`
can POST a fake success payload and mark a session as paid.

Things to do when this is picked up:

- Set `MPESA_WHITELISTED_IPS` on the Cloud Run service (Safaricom's published
  callback IPs; see `getMpesaIpWhitelist` in `utils/mpesa.js`).
- Fail closed in production: reject callbacks when the list is empty instead of
  only logging a warning.
- `getCallbackRequesterIp` trusts the first `X-Forwarded-For` entry, which a
  caller can forge. Confirm what Cloud Run puts in that header (it appends the
  real client IP) and read the right entry, or set `trust proxy` and use
  `req.ip`.
- Optionally confirm every success callback with `querySTKStatus` before
  completing a session, so a forged callback cannot mark anything paid even if
  the IP check is bypassed.
