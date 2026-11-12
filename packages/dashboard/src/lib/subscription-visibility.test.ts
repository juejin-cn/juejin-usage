import assert from 'node:assert/strict';
import test from 'node:test';
import { SUBSCRIPTION_CARD_CHANNELS, isSubscriptionChannelId, isSubscriptionChannelEnabled, isSubscriptionChannelVisibility } from '@juejin-opensource/jusage-core/subscription/shared/subscription-channels';

test('Trae cards are configurable and use local subscription API channels', () => {
  for (const id of ['trae-cn', 'trae-global'] as const) {
    assert.ok(SUBSCRIPTION_CARD_CHANNELS.some(channel => channel.id === id));
    assert.equal(isSubscriptionChannelId(id), true);
    assert.equal(isSubscriptionChannelEnabled({}, id), true);
    assert.equal(isSubscriptionChannelEnabled({ [id]: false }, id), false);
  }
  assert.equal(isSubscriptionChannelVisibility({ codex: false, 'trae-cn': false, 'trae-global': true }), true);
  assert.equal(isSubscriptionChannelVisibility({ 'trae-cn': 'yes' }), false);
  const allOff = Object.fromEntries(SUBSCRIPTION_CARD_CHANNELS.map(channel => [channel.id, false]));
  assert.equal(isSubscriptionChannelVisibility(allOff), true);
  assert.equal(isSubscriptionChannelEnabled(allOff, 'trae-cn'), false);
  assert.equal(isSubscriptionChannelEnabled(allOff, 'trae-global'), false);
});
