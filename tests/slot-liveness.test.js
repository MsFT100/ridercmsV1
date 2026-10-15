const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Reads a source file so we can assert on the real embedded SQL and logic.
 * @param {string} relativePath - Path relative to the repo root.
 * @returns {string} The full source.
 */
function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const firebaseSyncSource = readSource('utils/firebaseSync.js');
const hardwareCronSource = readSource('utils/cron-functions/hardware-cron.js');
const boothsControllerSource = readSource('controllers/admin/booths.controller.js');

describe('Slot liveness + stuck-session safety', () => {
  describe('syncSlotState records last_seen_at', () => {
    test('the slot update stamps last_seen_at', () => {
      const updateBlock = firebaseSyncSource.match(/UPDATE booth_slots[\s\S]*?WHERE id = \$6/);
      assert.ok(updateBlock, 'the syncSlotState slot update should exist');
      assert.match(updateBlock[0], /last_seen_at = NOW\(\)/);
    });
  });

  describe('resolveStuckWithdrawals is telemetry-gated', () => {
    test('it reads live telemetry before auto-completing', () => {
      assert.match(hardwareCronSource, /batteryLeft/, 'must compute whether the battery physically left');
      assert.match(hardwareCronSource, /telemetry\.batteryInserted === true/);
      assert.match(hardwareCronSource, /telemetry\.doorLocked === true/);
    });

    test('it leaves the session untouched when telemetry cannot confirm removal', () => {
      assert.match(hardwareCronSource, /does not confirm the battery has left \(or no telemetry\)/);
      assert.match(hardwareCronSource, /Leaving for admin resolution/);
    });

    test('the query carries booth/slot identifiers for the Firebase read', () => {
      assert.match(hardwareCronSource, /s\.slot_identifier, b\.booth_uid/);
    });
  });

  describe('reconcileStaleSlots sweep', () => {
    test('queries non-available slots whose telemetry is stale', () => {
      assert.match(hardwareCronSource, /status IN \('occupied', 'opening'\)/);
      assert.match(hardwareCronSource, /last_seen_at < NOW\(\) - make_interval\(mins => \$1::int\)/);
    });

    test('does nothing when live Firebase data is missing', () => {
      assert.match(hardwareCronSource, /if \(!snapshot\.exists\(\)\)/);
      assert.match(hardwareCronSource, /No live data for/);
      assert.match(hardwareCronSource, /leaving slot unchanged for admin resolution/);
    });

    test('forces a re-sync with a null slotBefore so identical snapshots are reprocessed', () => {
      assert.match(
        hardwareCronSource,
        /syncSlotState\(slot\.booth_uid, slot\.slot_identifier, snapshot\.val\(\), null\)/
      );
    });

    test('is scheduled on an interval and run on startup', () => {
      assert.match(hardwareCronSource, /setInterval\(\(\) => \{\s*reconcileStaleSlots\(\)/);
      assert.match(hardwareCronSource, /Initial stale slot reconciliation failed/);
    });
  });

  describe('purgeFailedSessions guards', () => {
    test('only purges rows with no M-Pesa checkout id and older than the retention window', () => {
      assert.match(
        hardwareCronSource,
        /DELETE FROM deposits\s+WHERE status = 'failed'\s+AND mpesa_checkout_id IS NULL\s+AND updated_at < NOW\(\) - INTERVAL '48 hours'/
      );
    });
  });

  describe('admin manual unlock resolves stuck state', () => {
    test('fails a lingering pending withdrawal', () => {
      assert.match(boothsControllerSource, /d\.status = 'pending'/);
      assert.match(boothsControllerSource, /Pending withdrawal failed by admin manual unlock/);
    });

    test('stamps last_seen_at on the reset slot', () => {
      assert.match(
        boothsControllerSource,
        /status = 'available',\s*current_battery_id = NULL,\s*last_seen_at = NOW\(\),\s*updated_at = NOW\(\)/
      );
    });
  });

  describe('module exports', () => {
    test('hardware-cron exports reconcileStaleSlots', () => {
      assert.match(hardwareCronSource, /reconcileStaleSlots,\s*\};/);
    });

    test('firebaseSync exports syncSlotState', () => {
      assert.match(firebaseSyncSource, /handleDepositCompletion,\s*syncSlotState,\s*\};/);
    });
  });
});
