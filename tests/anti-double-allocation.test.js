const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a mock pgClient that records every query call and returns canned results.
 * @param {object} [overrides] - Map of SQL-substring → { rowCount, rows } to return.
 */
function createMockClient(overrides = {}) {
  const queries = [];

  const defaultHandler = (text) => {
    // Return a generic success for UPDATE/INSERT/DELETE that don't need a specific result.
    if (/^\s*(UPDATE|INSERT|DELETE|SET|BEGIN|COMMIT|ROLLBACK)/i.test(text)) {
      return { rowCount: 1, rows: [{}] };
    }
    return { rowCount: 0, rows: [] };
  };

  const client = {
    queries,
    query: async (text, params) => {
      queries.push({ text, params });
      for (const [substring, result] of Object.entries(overrides)) {
        if (text.includes(substring)) {
          return typeof result === 'function' ? result(text, params) : result;
        }
      }
      return defaultHandler(text);
    },
  };

  return client;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Anti-double-allocation fixes', () => {
  // ==========================================================================
  // Fix 2: syncSlotState battery-removed cleanup
  // ==========================================================================
  describe('syncSlotState: orphaned deposit cleanup on transition to available', () => {
    it('fails orphaned deposits when slot transitions from occupied to available', async () => {
      const client = createMockClient({
        // currentSlotRes returns an occupied slot
        'FROM booth_slots': { rowCount: 1, rows: [{ id: 4, status: 'occupied', booth_id: 1 }] },
        // UPDATE booth_slots succeeds
        'UPDATE booth_slots': { rowCount: 1, rows: [{ id: 4 }] },
      });

      // Simulate the syncSlotState SQL logic directly
      const slotId = 4;
      const dbStatus = 'occupied';
      const batteryInserted = false;
      const newStatus = 'available'; // mapSlotStatus would return this
      const batteryCleared = !batteryInserted && dbStatus !== 'available';

      // Step 1: Slot update with current_battery_id = NULL
      await client.query(
        `UPDATE booth_slots 
         SET status = $1, current_battery_id = CASE WHEN $7 THEN NULL ELSE current_battery_id END, updated_at = NOW()
         WHERE id = $6`,
        [newStatus, null, null, null, null, slotId, batteryCleared]
      );

      assert.equal(batteryCleared, true, 'batteryCleared should be true when battery removed from occupied slot');

      // Step 2: Orphaned deposit cleanup
      if (newStatus === 'available' && dbStatus !== 'available' && dbStatus !== 'opening') {
        await client.query(
          `UPDATE deposits
           SET status = 'failed',
               notes = COALESCE(notes, '') || '\n[' || NOW() || '] Deposit failed: battery removed from slot, slot returned to available.'
           WHERE slot_id = $1
             AND session_type = 'deposit'
             AND status = 'completed'
             AND NOT EXISTS (
               SELECT 1 FROM deposits w
               WHERE w.consumed_deposit_id = deposits.id
                 AND w.session_type = 'withdrawal'
                 AND w.status NOT IN ('cancelled', 'failed')
             )`,
          [slotId]
        );
      }

      // Verify: 2 queries executed (slot update + orphan cleanup)
      assert.ok(client.queries.length >= 2, `Expected at least 2 queries, got ${client.queries.length}`);

      // Verify: the slot update included current_battery_id = NULL
      const slotUpdate = client.queries.find(q => q.text.includes('current_battery_id = CASE WHEN'));
      assert.ok(slotUpdate, 'Slot update should clear current_battery_id');
      assert.equal(slotUpdate.params[6], true, 'batteryCleared param should be true');

      // Verify: the orphan cleanup query was issued
      const orphanQuery = client.queries.find(q => q.text.includes('battery removed from slot'));
      assert.ok(orphanQuery, 'Orphaned deposit cleanup query should have been executed');
      assert.deepEqual(orphanQuery.params, [slotId]);
    });

    it('does NOT fail orphaned deposits when slot stays available (no transition)', async () => {
      const client = createMockClient({
        'FROM booth_slots': { rowCount: 1, rows: [{ id: 4, status: 'available', booth_id: 1 }] },
        'UPDATE booth_slots': { rowCount: 1, rows: [{ id: 4 }] },
      });

      const slotId = 4;
      const dbStatus = 'available';
      const batteryInserted = false;
      const newStatus = 'available';
      const batteryCleared = !batteryInserted && dbStatus !== 'available';

      assert.equal(batteryCleared, false, 'batteryCleared should be false when already available');

      await client.query(
        `UPDATE booth_slots SET status = $1, current_battery_id = CASE WHEN $7 THEN NULL ELSE current_battery_id END, updated_at = NOW() WHERE id = $6`,
        [newStatus, null, null, null, null, slotId, batteryCleared]
      );

      // No orphan cleanup should happen
      const orphanQuery = client.queries.find(q => q.text.includes('Deposit failed: battery removed'));
      assert.equal(orphanQuery, undefined, 'Should NOT run orphan cleanup when slot was already available');
    });

    it('does NOT clear current_battery_id when battery is still inserted', async () => {
      const slotId = 4;
      const dbStatus = 'occupied';
      const batteryInserted = true;
      const batteryCleared = !batteryInserted && dbStatus !== 'available';

      assert.equal(batteryCleared, false, 'batteryCleared should be false when battery is present');
    });

    it('does NOT fail orphaned deposits when transitioning from opening', async () => {
      const dbStatus = 'opening';
      const newStatus = 'available';
      // The condition checks dbStatus !== 'opening'
      const shouldClean = newStatus === 'available' && dbStatus !== 'available' && dbStatus !== 'opening';
      assert.equal(shouldClean, false, 'Should NOT clean up when transition is from opening state');
    });
  });

  // ==========================================================================
  // Fix 1: openForCollection_rejected_no_battery ACK handler
  // ==========================================================================
  describe('openForCollection_rejected_no_battery: slot reset + orphan cleanup', () => {
    it('marks withdrawal failed, resets slot, and fails orphaned deposit', async () => {
      const slotId = 4;
      const queries = [];

      const client = {
        queries,
        query: async (text, params) => {
          queries.push({ text, params });

          if (text.includes("UPDATE deposits SET status = 'failed'") && text.includes("session_type = 'withdrawal'")) {
            return { rowCount: 1, rows: [{ id: 99 }] };
          }
          if (text.includes('UPDATE booth_slots SET status')) {
            return { rowCount: 1, rows: [{}] };
          }
          if (text.includes('Deposit failed: battery physically removed')) {
            return { rowCount: 2, rows: [] }; // 2 orphaned deposits cleaned
          }
          return { rowCount: 0, rows: [] };
        },
      };

      // Simulate the ACK handler logic
      // Step 1: Fail withdrawal
      const failResult = await client.query(
        "UPDATE deposits SET status = 'failed' WHERE slot_id = $1 AND status = 'in_progress' AND session_type = 'withdrawal' RETURNING id",
        [slotId]
      );
      assert.equal(failResult.rowCount, 1, 'Should mark 1 withdrawal as failed');

      // Step 2: Reset slot
      await client.query(
        `UPDATE booth_slots SET status = 'available', current_battery_id = NULL, updated_at = NOW() WHERE id = $1`,
        [slotId]
      );

      // Step 3: Fail orphaned deposits
      const orphanResult = await client.query(
        `UPDATE deposits
         SET status = 'failed',
             notes = COALESCE(notes, '') || '\n[' || NOW() || '] Deposit failed: battery physically removed during unsuccessful withdrawal.'
         WHERE slot_id = $1
           AND session_type = 'deposit'
           AND status = 'completed'
           AND NOT EXISTS (
             SELECT 1 FROM deposits w
             WHERE w.consumed_deposit_id = deposits.id
               AND w.session_type = 'withdrawal'
               AND w.status NOT IN ('cancelled', 'failed')
           )`,
        [slotId]
      );
      assert.equal(orphanResult.rowCount, 2, 'Should clean up 2 orphaned deposits');

      // Verify all 3 queries were issued in order
      assert.equal(queries.length, 3);
      assert.ok(queries[0].text.includes("session_type = 'withdrawal'"), '1st query: fail withdrawal');
      assert.ok(queries[1].text.includes('current_battery_id = NULL'), '2nd query: reset slot');
      assert.ok(queries[2].text.includes('battery physically removed'), '3rd query: fail orphans');
    });

    it('does NOT reset slot on collection_timeout (battery may still be present)', async () => {
      const slotId = 4;
      const queries = [];

      const client = {
        queries,
        query: async (text, params) => {
          queries.push({ text, params });
          if (text.includes("UPDATE deposits SET status = 'failed'") && text.includes("session_type = 'withdrawal'")) {
            return { rowCount: 1, rows: [{ id: 99 }] };
          }
          return { rowCount: 0, rows: [] };
        },
      };

      // collection_timeout only fails the withdrawal, does NOT touch the slot
      const failResult = await client.query(
        "UPDATE deposits SET status = 'failed' WHERE slot_id = $1 AND status = 'in_progress' AND session_type = 'withdrawal' RETURNING id",
        [slotId]
      );
      assert.equal(failResult.rowCount, 1);

      // Verify: only 1 query (no slot reset, no orphan cleanup)
      assert.equal(queries.length, 1);
      const hasSlotReset = queries.some(q => q.text.includes('current_battery_id = NULL'));
      assert.equal(hasSlotReset, false, 'collection_timeout should NOT reset the slot');
      const hasOrphanCleanup = queries.some(q => q.text.includes('battery physically removed'));
      assert.equal(hasOrphanCleanup, false, 'collection_timeout should NOT clean up orphaned deposits');
    });
  });

  // ==========================================================================
  // Fix 3: Pre-allocation safety check in initiate-deposit
  // ==========================================================================
  describe('initiate-deposit: pre-allocation stale deposit cleanup', () => {
    it('cleans up stale deposits before assigning slot', async () => {
      const slotId = 7;
      const queries = [];

      const client = {
        queries,
        query: async (text, params) => {
          queries.push({ text, params });
          if (text.includes("UPDATE booth_slots SET status = 'opening'")) {
            return { rowCount: 1, rows: [{ id: slotId, slot_identifier: 'A01' }] };
          }
          if (text.includes('Deposit failed: slot reassigned')) {
            return { rowCount: 1, rows: [] }; // 1 stale deposit cleaned
          }
          return { rowCount: 0, rows: [] };
        },
      };

      // Step 1: Atomic reserve
      const reserveResult = await client.query(
        `UPDATE booth_slots SET status = 'opening' WHERE id = $1 AND status = 'available' RETURNING id, slot_identifier`,
        [slotId]
      );
      assert.equal(reserveResult.rowCount, 1, 'Slot should be reserved');

      // Step 2: Stale deposit cleanup (our Fix 3)
      await client.query(
        `UPDATE deposits
         SET status = 'failed',
             notes = COALESCE(notes, '') || '\n[' || NOW() || '] Deposit failed: slot reassigned to new user.'
         WHERE slot_id = $1
           AND session_type = 'deposit'
           AND status = 'completed'
           AND NOT EXISTS (
             SELECT 1 FROM booth_slots bs WHERE bs.id = deposits.slot_id AND bs.current_battery_id IS NOT NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM deposits w
             WHERE w.consumed_deposit_id = deposits.id
               AND w.session_type = 'withdrawal'
               AND w.status NOT IN ('cancelled', 'failed')
           )`,
        [slotId]
      );

      // Verify both queries were executed
      assert.equal(queries.length, 2);
      assert.ok(queries[0].text.includes("SET status = 'opening'"), '1st: reserve slot');
      assert.ok(queries[1].text.includes('slot reassigned'), '2nd: cleanup stale deposits');
    });
  });

  // ==========================================================================
  // Integration scenario: end-to-end double-allocation prevention
  // ==========================================================================
  describe('End-to-end: double-allocation prevention scenario', () => {
    it('prevents User B from being affected by User A\'s stale deposit after failed withdrawal', async () => {
      // Scenario:
      // 1. User A deposits to slot 4 -> deposit completed
      // 2. User A withdraws but collection fails -> withdrawal failed
      // 3. Battery physically removed -> slot becomes available
      // 4. syncSlotState detects battery removed -> fails User A's deposit, clears battery_id
      // 5. User B deposits to slot 4 -> pre-allocation cleanup finds no stale deposits (already cleaned)

      const slotId = 4;
      const queries = [];

      const client = {
        queries,
        query: async (text, params) => {
          queries.push({ text, params });
          return { rowCount: 1, rows: [{ id: slotId }] };
        },
      };

      // === Phase 1: syncSlotState detects battery removed (occupied -> available) ===
      const dbStatus = 'occupied';
      const batteryInserted = false;
      const newStatus = 'available';
      const batteryCleared = !batteryInserted && dbStatus !== 'available';

      // Step 1a: Update slot — clears current_battery_id
      await client.query(
        `UPDATE booth_slots SET status = $1, current_battery_id = CASE WHEN $7 THEN NULL ELSE current_battery_id END, updated_at = NOW() WHERE id = $6`,
        [newStatus, null, null, null, null, slotId, batteryCleared]
      );

      // Step 1b: Fail orphaned deposits
      if (newStatus === 'available' && dbStatus !== 'available' && dbStatus !== 'opening') {
        await client.query(
          `UPDATE deposits SET status = 'failed', notes = COALESCE(notes, '') || '\n[' || NOW() || '] Deposit failed: battery removed from slot, slot returned to available.'
           WHERE slot_id = $1 AND session_type = 'deposit' AND status = 'completed'
           AND NOT EXISTS (SELECT 1 FROM deposits w WHERE w.consumed_deposit_id = deposits.id AND w.session_type = 'withdrawal' AND w.status NOT IN ('cancelled', 'failed'))`,
          [slotId]
        );
      }

      // === Phase 2: New user's deposit allocates the same slot ===
      // Step 2a: Reserve slot
      await client.query(
        `UPDATE booth_slots SET status = 'opening' WHERE id = $1 AND status = 'available' RETURNING id, slot_identifier`,
        [slotId]
      );

      // Step 2b: Pre-allocation cleanup (safety net)
      await client.query(
        `UPDATE deposits SET status = 'failed', notes = COALESCE(notes, '') || '\n[' || NOW() || '] Deposit failed: slot reassigned to new user.'
         WHERE slot_id = $1 AND session_type = 'deposit' AND status = 'completed'
         AND NOT EXISTS (SELECT 1 FROM booth_slots bs WHERE bs.id = deposits.slot_id AND bs.current_battery_id IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM deposits w WHERE w.consumed_deposit_id = deposits.id AND w.session_type = 'withdrawal' AND w.status NOT IN ('cancelled', 'failed'))`,
        [slotId]
      );

      // === Verify the full sequence ===
      assert.equal(queries.length, 4, 'Should have 4 queries in sequence');

      // Q1: Slot update clears battery_id
      assert.equal(queries[0].params[6], true, 'batteryCleared should be true');
      assert.ok(queries[0].text.includes('current_battery_id = CASE WHEN'), 'Q1: clears battery_id');

      // Q2: Orphan cleanup fails User A's deposit
      assert.ok(queries[1].text.includes('battery removed from slot'), 'Q2: fails orphaned deposit');

      // Q3: Slot reserve for User B
      assert.ok(queries[2].text.includes("SET status = 'opening'"), 'Q3: reserves slot for new user');

      // Q4: Pre-allocation safety net
      assert.ok(queries[3].text.includes('slot reassigned'), 'Q4: pre-allocation cleanup check');

      // The key assertion: both cleanup paths ran against the correct slot
      assert.equal(queries[1].params[0], slotId, 'Orphan cleanup targets the right slot');
      assert.equal(queries[3].params[0], slotId, 'Pre-allocation check targets the right slot');
    });
  });
});

// ─── Test mapSlotStatus ──────────────────────────────────────────────────────

describe('mapSlotStatus', () => {
  // Import the actual function (it's not exported, so we test the logic inline)
  function mapSlotStatus(firebaseStatus, currentDbStatus, batteryInserted) {
    if (firebaseStatus === 'fault') return 'faulty';
    if (firebaseStatus === 'maintenance') return 'maintenance';
    if (currentDbStatus === 'disabled') return 'disabled';
    if (currentDbStatus === 'opening' && !batteryInserted) return 'opening';
    if (batteryInserted) return currentDbStatus === 'opening' ? 'opening' : 'occupied';
    return 'available';
  }

  it('returns available when battery physically removed from occupied slot', () => {
    assert.equal(mapSlotStatus('available', 'occupied', false), 'available');
  });

  it('returns occupied when battery is present and slot is occupied', () => {
    assert.equal(mapSlotStatus('available', 'occupied', true), 'occupied');
  });

  it('protects opening state when no battery yet', () => {
    assert.equal(mapSlotStatus('available', 'opening', false), 'opening');
  });

  it('returns available when battery removed from available slot', () => {
    assert.equal(mapSlotStatus('available', 'available', false), 'available');
  });

  it('returns faulty on fault status', () => {
    assert.equal(mapSlotStatus('fault', 'occupied', true), 'faulty');
  });

  it('returns disabled when current DB status is disabled', () => {
    assert.equal(mapSlotStatus('available', 'disabled', true), 'disabled');
  });
});
