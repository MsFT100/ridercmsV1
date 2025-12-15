// This script tests the cost calculation logic locally, without making any API calls.
// It's useful for quickly verifying that the pricing math is correct for various scenarios.

// --- Configuration ---
// Hardcoded pricing rules for local simulation.
// These should match the values in your database's app_settings table for the 'pricing' key.
const pricingRules = {
  base_swap_fee: 50,
  cost_per_charge_percent: 10,
  overtime_penalty_per_minute: 20,
  grace_period_minutes: 60, // Example grace period of 2 hours
};

// --- Test Scenarios ---
// Define different scenarios you want to test.
const scenarios = [
  {
    description: "Standard charge, no overtime",
    initialCharge: 20,
    finalCharge: 85,
    durationMinutes: 90,
  },
  {
    description: "Standard charge, with overtime",
    initialCharge: 10,
    finalCharge: 95,
    durationMinutes: 150,
  },
  {
    description: "Small charge, no overtime",
    initialCharge: 80,
    finalCharge: 90,
    durationMinutes: 15,
  },
  {
    description: "No charge added, but kept for a long time (overtime)",
    initialCharge: 50,
    finalCharge: 50,
    durationMinutes: 200,
  },
  {
    description: "Very small charge (testing rounding)",
    initialCharge: 45.1,
    finalCharge: 45.8,
    durationMinutes: 5,
  }
];

/**
 * Simulates the cost calculation for a withdrawal session locally.
 * This logic should be kept in sync with the backend endpoint.
 * @param {number} initialCharge - The battery's charge percentage at the start.
 * @param {number} finalCharge - The battery's charge percentage at the end.
 * @param {number} durationMinutes - The total duration of the session in minutes.
 * @returns {object} A detailed breakdown of the calculated cost.
 */
function calculateCost(initialCharge, finalCharge, durationMinutes) {
  const {
    base_swap_fee: baseSwapFee,
    cost_per_charge_percent: costPerChargePercent,
    overtime_penalty_per_minute: overtimePenaltyPerMin,
    grace_period_minutes: gracePeriodMinutes,
  } = pricingRules;

  // Perform the same calculation as in the backend
  const chargeAdded = Math.max(0, parseFloat(finalCharge) - parseFloat(initialCharge));
  const chargingCost = chargeAdded * parseFloat(costPerChargePercent);

  // New calculation: The cost is the greater of the base fee or the calculated charging cost.
  const totalCost = parseFloat(Math.max(baseSwapFee, chargingCost).toFixed(2));

  return {
    chargeAdded: parseFloat(chargeAdded.toFixed(2)),
    chargingCost: parseFloat(chargingCost.toFixed(2)),
    totalCost,
  };
}

function runSimulations() {
  console.log('Running cost calculation simulations...\n');

  for (const scenario of scenarios) {
    console.log(`--- Testing: ${scenario.description} ---`);
    const calculation = calculateCost(scenario.initialCharge, scenario.finalCharge, scenario.durationMinutes);
    console.log(JSON.stringify(calculation, null, 2));
    console.log('\n');
  }
}

runSimulations();