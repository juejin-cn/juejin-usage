import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalSubscriptionPlanLabel, trayPlanLabel } from './subscription-plan';

test('normalizes official plan ids into generic subscription tiers', () => {
  assert.equal(canonicalSubscriptionPlanLabel('personal_professional'), 'Pro');
  assert.equal(canonicalSubscriptionPlanLabel('pro_plus'), 'Pro+');
  assert.equal(canonicalSubscriptionPlanLabel('Max_20x'), 'Max 20x');
  assert.equal(canonicalSubscriptionPlanLabel('Google AI Ultra'), 'Ultra');
  assert.equal(canonicalSubscriptionPlanLabel('teams'), 'Team');
});

test('retains non-equivalent official plan names', () => {
  assert.equal(canonicalSubscriptionPlanLabel('SuperGrok Heavy'), 'SuperGrok Heavy');
  assert.equal(canonicalSubscriptionPlanLabel('Future Tier'), 'Future Tier');
});

test('keeps paid and organization subscription plan labels', () => {
  assert.equal(trayPlanLabel('Plus'), 'Plus');
  assert.equal(trayPlanLabel(' Max 5x '), 'Max 5x');
  assert.equal(trayPlanLabel('Team'), 'Team');
  assert.equal(trayPlanLabel('Future Tier'), 'Future Tier');
});

test('hides absent and free subscription plan labels', () => {
  assert.equal(trayPlanLabel(null), null);
  assert.equal(trayPlanLabel(undefined), null);
  assert.equal(trayPlanLabel('   '), null);
  assert.equal(trayPlanLabel('Free'), null);
  assert.equal(trayPlanLabel(' FREE '), null);
});
