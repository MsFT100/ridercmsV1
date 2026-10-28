// @ts-check

/**
 * Normalizes a Kenyan mobile number to E.164 (+254XXXXXXXXX), the format Firebase
 * Auth requires and the one stored in `users.phone`.
 *
 * Accepts the shapes riders actually type: `+254712345678`, `254712345678`,
 * `0712345678`, `712345678`, optionally with spaces, dashes, dots or brackets.
 * @param {unknown} input - The raw phone number entered by the user.
 * @returns {string | null} The E.164 number, or null if it is not a valid Kenyan mobile number.
 */
function normalizeKenyanPhone(input) {
  if (typeof input !== 'string') return null;

  const compact = input.trim().replace(/[\s\-.()]/g, '');
  if (!/^\+?\d+$/.test(compact)) return null;

  let digits = compact.startsWith('+') ? compact.slice(1) : compact;
  if (digits.startsWith('00254')) digits = digits.slice(2);

  if (digits.startsWith('254')) {
    digits = digits.slice(3);
  } else if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  // Safaricom/Airtel mobile numbers: 7XXXXXXXX or 1XXXXXXXX after the country code.
  if (!/^[17]\d{8}$/.test(digits)) return null;

  return `+254${digits}`;
}

module.exports = { normalizeKenyanPhone };
