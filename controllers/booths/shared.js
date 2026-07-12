const getEnvInt = (name, fallback) => {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Normalizes a State of Charge (SoC) value.
 * @param {number|string} rawSoc - The raw SoC value to normalize.
 * @returns {number|null} The normalized SoC as a number, or null if invalid.
 */
function normalizeSoc(rawSoc) {
  const parsed = Number(rawSoc);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
    return null;
  }
  return parsed;
}

/**
 * Extracts a valid State of Charge (SoC) from slot data.
 * @param {object} slotData - The slot data object containing telemetry or top-level SoC.
 * @param {number|string|null} [fallbackSoc] - A fallback SoC value if none is found in slotData.
 * @returns {number|null} The valid SoC found, or null.
 */
function extractValidSoc(slotData, fallbackSoc = null) {
  const telemetrySoc = normalizeSoc(slotData?.telemetry?.soc);
  if (telemetrySoc !== null) {
    return telemetrySoc;
  }

  const topLevelSoc = normalizeSoc(slotData?.soc);
  if (topLevelSoc !== null) {
    return topLevelSoc;
  }

  return normalizeSoc(fallbackSoc);
}

/**
 * Determines if the relay is off for a given slot.
 * @param {object} slotData - The slot data object.
 * @returns {boolean} True if the relay is confirmed to be off, false otherwise.
 */
function isRelayOff(slotData) {
  if (!slotData || typeof slotData !== 'object') {
    return false;
  }

  const ack = slotData?.command?.ack;
  if (typeof ack === 'string' && ack.includes('stopCharging_done')) {
    return true;
  }

  if (typeof slotData?.telemetry?.relayOn === 'boolean') {
    return slotData.telemetry.relayOn === false;
  }

  if (typeof slotData?.relayOn === 'boolean') {
    return slotData.relayOn === false;
  }

  if (typeof slotData?.relay === 'string') {
    return slotData.relay.trim().toUpperCase() === 'OFF';
  }

  return false;
}

const WITHDRAWAL_BATTERY_QUERY = `
  -- Find the user's "deposit credit" and the details of the battery they deposited.
  -- This credit is a completed deposit session that hasn't been redeemed by a withdrawal
  -- and whose slot still has a battery.
  SELECT
    d.id as "depositCreditId",
    d.completed_at AS "depositCompletedAt",
    d.initial_charge_level AS "initialCharge",
    s.id AS "slotId",
    s.slot_identifier AS "slotIdentifier",
    s.charge_level_percent AS "chargeLevel",
    b.id AS "boothId",
    b.booth_uid AS "boothUid"
  FROM deposits d
  JOIN booth_slots s ON d.slot_id = s.id
  JOIN booths b ON d.booth_id = b.id
  WHERE d.user_id = $1
    AND d.session_type = 'deposit'
    AND d.status = 'completed'
    AND s.current_battery_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM deposits w
      WHERE w.consumed_deposit_id = d.id
        AND w.session_type = 'withdrawal'
        AND w.status NOT IN ('cancelled', 'failed')
    )
  ORDER BY d.completed_at DESC
  LIMIT 1;
`;

const WITHDRAWAL_BATTERY_BY_ID_QUERY = `
  SELECT
    d.id as "depositCreditId",
    d.completed_at AS "depositCompletedAt",
    d.initial_charge_level AS "initialCharge",
    s.id AS "slotId",
    s.slot_identifier AS "slotIdentifier",
    s.charge_level_percent AS "chargeLevel",
    b.id AS "boothId",
    b.booth_uid AS "boothUid"
  FROM deposits d
  JOIN booth_slots s ON d.slot_id = s.id
  JOIN booths b ON d.booth_id = b.id
  WHERE d.id = $1
    AND d.user_id = $2
    AND d.session_type = 'deposit'
    AND d.status = 'completed'
    AND s.current_battery_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM deposits w
      WHERE w.consumed_deposit_id = d.id
        AND w.session_type = 'withdrawal'
        AND w.status NOT IN ('cancelled', 'failed')
    );
`;

/**
 * Gets the battery context for a withdrawal.
 * @param {object} client - The database client.
 * @param {string} firebaseUid - The Firebase UID of the user.
 * @param {number} [sessionId] - Optional deposit session ID to target a specific credit.
 * @returns {Promise<object>} The battery context object.
 */
async function getWithdrawalBatteryContext(client, firebaseUid, sessionId = null) {
  let query;
  let params;

  if (sessionId) {
    query = WITHDRAWAL_BATTERY_BY_ID_QUERY;
    params = [sessionId, firebaseUid];
  } else {
    query = WITHDRAWAL_BATTERY_QUERY;
    params = [firebaseUid];
  }

  const batteryRes = await client.query(query, params);

  if (batteryRes.rows.length === 0) {
    throw new Error('NO_DEPOSITED_BATTERY');
  }

  return batteryRes.rows[0];
}

/**
 * Checks if a booth UID is a virtual dev booth.
 * Dev booths skip Firebase hardware interactions and simulate responses.
 * @param {string} boothUid
 * @returns {boolean}
 */
const isDevBooth = (boothUid) => typeof boothUid === 'string' && boothUid.startsWith('dev-');

module.exports = {
  getEnvInt,
  extractValidSoc,
  isRelayOff,
  getWithdrawalBatteryContext,
  isDevBooth,
};
