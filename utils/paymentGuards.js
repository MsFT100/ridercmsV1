// @ts-check

/**
 * Guards for the rider-facing "pay" endpoints (withdrawal + rental).
 *
 * Kept free of DB/HTTP imports so the rules can be unit tested directly.
 */

/**
 * How long an STK push is considered live. The status endpoints start asking
 * M-Pesa after `MPESA_PENDING_TIMEOUT_SECONDS`; the extra margin covers the
 * handset prompt plus callback latency.
 * @returns {number} Seconds.
 */
const getInFlightSeconds = () =>
  (parseInt(String(process.env.MPESA_PENDING_TIMEOUT_SECONDS), 10) || 60) + 30;

/**
 * Normalises a Kenyan mobile number to `2547XXXXXXXX` / `2541XXXXXXXX`.
 * Accepts `+254…`, `254…`, `07…`, `01…` and bare 9-digit forms.
 * @param {unknown} raw
 * @returns {string|null} The normalised number, or null if it is not a valid mobile.
 */
const normalizeKenyanPhone = (raw) => {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 12) return null;
  const national = digits.slice(-9);
  if (!/^[71]\d{8}$/.test(national)) return null;
  return `254${national}`;
};

/**
 * Returns the first candidate that is a valid mobile number.
 * @param {...unknown} candidates In priority order.
 * @returns {string|null}
 */
const pickPayerPhone = (...candidates) => {
  for (const candidate of candidates) {
    const normalized = normalizeKenyanPhone(candidate);
    if (normalized) return normalized;
  }
  return null;
};

/**
 * Reads the rider's phone from the users table (used when the Firebase token
 * has no `phone_number` claim, e.g. Google sign-in).
 * @param {{ query: Function }} client
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
const getStoredPhone = async (client, userId) => {
  const res = await client.query('SELECT phone FROM users WHERE user_id = $1', [userId]);
  return res.rows[0]?.phone ?? null;
};

/**
 * Decides what an earlier STK push means for a new pay request.
 *
 *  - `none`      no earlier push to worry about (never sent, dev, or it failed)
 *  - `in_flight` a push was sent moments ago; the rider may still be entering a PIN
 *  - `stale`     the push is old enough that M-Pesa should be asked what happened
 *
 * @param {{ status?: string, mpesa_checkout_id?: string|null, started_at?: Date|string|null }} row
 * @param {string} waitingStatus The session status that means "awaiting payment".
 * @param {number} [nowMs]
 * @param {number} [inFlightSeconds]
 * @returns {'none'|'in_flight'|'stale'}
 */
const classifyExistingPayment = (
  row,
  waitingStatus,
  nowMs = Date.now(),
  inFlightSeconds = getInFlightSeconds()
) => {
  const checkoutId = row.mpesa_checkout_id;
  if (!checkoutId || checkoutId.startsWith('DEV_')) return 'none';
  if (row.status !== waitingStatus) return 'none';

  const startedMs = row.started_at ? new Date(row.started_at).getTime() : NaN;
  if (Number.isNaN(startedMs)) return 'stale';

  return nowMs - startedMs < inFlightSeconds * 1000 ? 'in_flight' : 'stale';
};

/**
 * Asks M-Pesa whether an earlier push was actually paid, so a retry never
 * charges the rider twice. A failed lookup counts as "not paid" - the
 * callback/status endpoints remain the source of truth for the old request.
 *
 * @param {(checkoutRequestId: string) => Promise<{ data?: { ResultCode?: string|number } }>} queryStatus
 * @param {string} checkoutRequestId
 * @param {{ warn: Function }} [log]
 * @returns {Promise<boolean>}
 */
const wasPreviousPaymentPaid = async (queryStatus, checkoutRequestId, log) => {
  try {
    const response = await queryStatus(checkoutRequestId);
    return String(response?.data?.ResultCode) === '0';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log?.warn(`Could not verify earlier payment ${checkoutRequestId}: ${message}`);
    return false;
  }
};

module.exports = {
  getInFlightSeconds,
  normalizeKenyanPhone,
  pickPayerPhone,
  getStoredPhone,
  classifyExistingPayment,
  wasPreviousPaymentPaid,
};
