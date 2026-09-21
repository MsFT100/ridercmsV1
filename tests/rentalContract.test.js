const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Reads the rental controller source to assert on the real embedded SQL.
 * Guards the rider rental contract: feature flags exposed to the app, the
 * return-completion signal, and ownership rules that assume a rider's own
 * deposited battery carries NO battery identity (`current_battery_id` NULL).
 * @returns {string} The controller source.
 */
function readRentalController() {
  return fs.readFileSync(
    path.join(__dirname, '../controllers/booths/rental.controller.js'),
    'utf8'
  );
}

/**
 * Models the `returnCompleted` flag from `/rentals/active`: a return is only
 * complete once a return slot is reserved AND has physically flipped to
 * `occupied`. `returned` alone (slot reserved, cabinet still open) must not
 * be treated as done or the app unlocks the rider's battery prematurely.
 * @param {{returnSlotId:number|null, returnSlotStatus:string|null}} row The active-rental row fields.
 * @returns {boolean} True once the return slot is physically occupied.
 */
function computeReturnCompleted(row) {
  return (
    !!row.returnSlotId && row.returnSlotStatus === 'occupied'
  );
}

describe('rental contract: feature flags', () => {
  test('GET /rentals/status exposes the issuance scan flag', () => {
    const src = readRentalController();
    assert.match(src, /'\/rentals\/status'/);
    assert.match(
      src,
      /requireBoothScanBeforeIssue: rent\.require_rental_scan_before_issue === true/
    );
  });

  test('GET /rentals/status exposes the return scan flag', () => {
    const src = readRentalController();
    assert.match(
      src,
      /requireReturnScan: rent\.require_return_scan === true/
    );
  });

  test('GET /rentals/status exposes the minimum SOC eligibility guard', () => {
    const src = readRentalController();
    assert.match(src, /minimumSocPercent/);
  });
});

describe('rental contract: return completion signal', () => {
  test('GET /rentals/active selects the return slot status', () => {
    const src = readRentalController();
    assert.match(src, /retS\.status AS "returnSlotStatus"/);
  });

  test('returnCompleted requires an occupied return slot', () => {
    const src = readRentalController();
    assert.match(
      src,
      /returnCompleted: !!row\.return_slot_id && row\.returnSlotStatus === 'occupied'/
    );
  });

  test('a reserved-but-not-inserted return slot is NOT complete', () => {
    assert.strictEqual(
      computeReturnCompleted({ returnSlotId: 4, returnSlotStatus: 'open' }),
      false
    );
    assert.strictEqual(
      computeReturnCompleted({
        returnSlotId: 4,
        returnSlotStatus: 'charged',
      }),
      false
    );
  });

  test('an occupied return slot IS complete', () => {
    assert.strictEqual(
      computeReturnCompleted({
        returnSlotId: 4,
        returnSlotStatus: 'occupied',
      }),
      true
    );
  });

  test('no reserved slot is NOT complete', () => {
    assert.strictEqual(
      computeReturnCompleted({
        returnSlotId: null,
        returnSlotStatus: null,
      }),
      false
    );
  });
});

describe('rental contract: rider-deposit identity rules', () => {
  test('issuing a rental does NOT require the own deposit to have a battery id', () => {
    const src = readRentalController();
    // A rider's own deposited battery has `current_battery_id = NULL`; presence
    // is tracked by slot occupancy only.
    assert.ok(
      !src.includes('current_battery_id IS NOT NULL'),
      'rental controller must not gate rider deposits on current_battery_id'
    );
  });

  test('unlocking the own battery only requires an occupied slot', () => {
    const src = readRentalController();
    assert.match(src, /WHERE id = \$1 AND status = 'occupied'/);
  });
});
