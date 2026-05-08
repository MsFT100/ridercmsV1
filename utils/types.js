/**
 * @typedef {object} BoothRow
 * @property {number} id - Internal primary key
 * @property {string} booth_uid - Public unique identifier
 * @property {string} name - Booth name
 * @property {string} location_address - Physical address
 * @property {string} status - 'online', 'offline', or 'maintenance'
 * @property {number|null} latitude - Latitude of the booth
 * @property {number|null} longitude - Longitude of the booth
 * @property {string} created_at - ISO timestamp
 * @property {string} updated_at - ISO timestamp
 */

/**
 * @typedef {object} DepositRow
 * @property {number} id - Session ID
 * @property {string} user_id - Firebase UID of the user
 * @property {number} booth_id - Link to booth
 * @property {number} slot_id - Link to slot
 * @property {string} session_type - 'deposit' or 'withdrawal'
 * @property {string} status - 'pending', 'opening', 'in_progress', 'completed', 'failed', 'cancelled', 'redeemed'
 * @property {number|null} amount - Payment amount
 * @property {string|null} mpesa_checkout_id - Safaricom ID
 * @property {number|null} initial_charge_level - SOC at start
 * @property {number|null} final_charge_level - SOC at end
 * @property {string} created_at - ISO timestamp
 * @property {string|null} notes - Processing notes
 */

/**
 * @typedef {object} BoothSlotRow
 * @property {number} id - Internal primary key
 * @property {number} booth_id - Link to booth
 * @property {string} slot_identifier - e.g., 'slot001'
 * @property {string} status - 'available', 'occupied', 'faulty', 'disabled'
 * @property {string} door_status - 'open', 'closed', 'locked'
 * @property {number|null} current_battery_id - Internal ID of the inserted battery
 * @property {number|null} charge_level_percent - Current SOC
 * @property {boolean} is_charging - Whether the slot is currently charging
 * @property {object | null} telemetry - JSONB telemetry object
 */

module.exports = {};
