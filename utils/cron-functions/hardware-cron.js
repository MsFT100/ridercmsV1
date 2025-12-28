// d:\node\ridercmsV1\utils\cron-functions\hardware-cron.js
const { getDatabase } = require('firebase-admin/database');
const poolPromise = require('../../db');
const logger = require('../logger');

/**
 * Checks for slots that meet all safety conditions for charging but are not currently charging.
 * If found, it sends a 'startCharging' command to the hardware.
 */
async function checkChargingConditions() {
  const pool = await poolPromise;
  const client = await pool.connect();

  try {
    // Query for slots where:
    // 1. Telemetry indicates a safe, ready state (Battery in, Door closed & locked, Plug connected).
    // 2. The database thinks charging is OFF (is_charging is false or null).
    // 3. The slot is not in a maintenance or faulty state.
    const query = `
      SELECT
        s.id,
        s.slot_identifier,
        b.booth_uid,
        s.telemetry
      FROM booth_slots s
      JOIN booths b ON s.booth_id = b.id
      WHERE
        (s.telemetry->>'batteryInserted')::boolean = true
        AND (s.telemetry->>'doorClosed')::boolean = true
        AND (s.telemetry->>'doorLocked')::boolean = true
        AND (s.telemetry->>'plugConnected')::boolean = true
        AND (s.is_charging IS FALSE OR s.is_charging IS NULL)
        AND s.status NOT IN ('maintenance', 'faulty', 'disabled')
    `;

    const { rows } = await client.query(query);

    if (rows.length > 0) {
      logger.info(`[HardwareCron] Found ${rows.length} slots ready for charging but inactive. Initiating self-healing...`);
      
      const db = getDatabase();

      for (const row of rows) {
        const { id, slot_identifier, booth_uid } = row;
        
        logger.info(`[HardwareCron] Sending 'startCharging' command to ${booth_uid}/${slot_identifier}`);

        try {
          // 1. Send command to Firebase to trigger the hardware
          await db.ref(`booths/${booth_uid}/slots/${slot_identifier}/command`).update({
            startCharging: true,
            stopCharging: false
          });

          // 2. Optimistically update DB to prevent this cron from re-triggering immediately 
          //    before the hardware has a chance to respond with an ACK.
          await client.query("UPDATE booth_slots SET is_charging = true WHERE id = $1", [id]);
        } catch (err) {
          logger.error(`[HardwareCron] Failed to send command to ${booth_uid}/${slot_identifier}:`, err);
        }
      }
    }
  } catch (error) {
    logger.error('[HardwareCron] Error checking charging conditions:', error);
  } finally {
    client.release();
  }
}

/**
 * Starts the cron job interval.
 */
function startCronJob() {
  logger.info('[HardwareCron] Starting charging condition check cron (Interval: 1 minute).');
  
  // Run immediately on server start
  checkChargingConditions();

  // Then run every 60 seconds
  setInterval(checkChargingConditions, 60 * 1000);
}

module.exports = { startCronJob };
