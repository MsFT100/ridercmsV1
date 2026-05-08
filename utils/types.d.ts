export type BoothRow = {
    /**
     * - Internal primary key
     */
    id: number;
    /**
     * - Public unique identifier
     */
    booth_uid: string;
    /**
     * - Booth name
     */
    name: string;
    /**
     * - Physical address
     */
    location_address: string;
    /**
     * - 'online', 'offline', or 'maintenance'
     */
    status: string;
    latitude: number | null;
    longitude: number | null;
    /**
     * - ISO timestamp
     */
    created_at: string;
    /**
     * - ISO timestamp
     */
    updated_at: string;
};
export type DepositRow = {
    /**
     * - Session ID
     */
    id: number;
    /**
     * - Firebase UID of the user
     */
    user_id: string;
    /**
     * - Link to booth
     */
    booth_id: number;
    /**
     * - Link to slot
     */
    slot_id: number;
    /**
     * - 'deposit' or 'withdrawal'
     */
    session_type: string;
    /**
     * - 'pending', 'opening', 'in_progress', 'completed', 'failed', 'cancelled', 'redeemed'
     */
    status: string;
    /**
     * - Payment amount
     */
    amount: number | null;
    /**
     * - Safaricom ID
     */
    mpesa_checkout_id: string | null;
    /**
     * - SOC at start
     */
    initial_charge_level: number | null;
    /**
     * - SOC at end
     */
    final_charge_level: number | null;
    created_at: string;
    /**
     * - Processing notes
     */
    notes: string | null;
};
export type BoothSlotRow = {
    id: number;
    booth_id: number;
    /**
     * - e.g., 'slot001'
     */
    slot_identifier: string;
    /**
     * - 'available', 'occupied', 'faulty', 'disabled'
     */
    status: string;
    /**
     * - 'open', 'closed', 'locked'
     */
    door_status: string;
    current_battery_id: number | null;
    charge_level_percent: number | null;
    is_charging: boolean;
    /**
     * - JSONB telemetry object
     */
    telemetry: any | null;
};
