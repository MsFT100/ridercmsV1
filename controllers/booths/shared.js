const getEnvInt = (name, fallback) => {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

function normalizeSoc(rawSoc) {
  const parsed = Number(rawSoc);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
    return null;
  }
  return parsed;
}

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
  -- This credit is a completed deposit session that hasn't been redeemed by a withdrawal.
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
    AND d.status = 'completed' -- 'completed' means deposited, 'redeemed' means withdrawn against.
  ORDER BY d.completed_at DESC
  LIMIT 1;
`;

async function getWithdrawalBatteryContext(client, firebaseUid) {
  const batteryRes = await client.query(WITHDRAWAL_BATTERY_QUERY, [firebaseUid]);

  if (batteryRes.rows.length === 0) {
    throw new Error('NO_DEPOSITED_BATTERY');
  }

  return batteryRes.rows[0];
}

module.exports = {
  getEnvInt,
  extractValidSoc,
  isRelayOff,
  getWithdrawalBatteryContext,
};
