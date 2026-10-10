import test from 'node:test';
import assert from 'node:assert/strict';
import { createWholesaleFeatureActions, wholesaleFeatureDefaults } from '../src/lib/wholesaleFeature.ts';
import { canAccess, canSellWholesale, canReturnWholesale } from '../src/lib/roles.ts';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  let state = { ...wholesaleFeatureDefaults }, store = 'A', admin = true;
  const values = new Map(), calls = []; let readError = false, saveError = false, waitRead, waitSave;
  const client = { from(table) {
    let update, id;
    const query = {
      update(payload) { update = payload; return query; },
      select() { return query; }, eq(_, value) { id = value; return query; },
      async single() {
        calls.push({ table, id, update });
        const value = values.get(id) ?? false;
        if (update) {
          if (waitSave) await waitSave.promise;
          if (saveError) return { error: new Error('network') };
          values.set(id, update.wholesale_enabled);
          return { data: { wholesale_enabled: update.wholesale_enabled } };
        }
        if (waitRead) await waitRead.promise;
        return readError ? { error: new Error('read') } : { data: { wholesale_enabled: value } };
      },
    }; return query;
  } };
  const actions = createWholesaleFeatureActions(() => state, patch => { state = { ...state, ...patch }; }, {
    client: () => client, storeId: async () => store, isAdmin: () => admin,
  });
  return { actions, get state() { return state; }, values, calls,
    store(value) { store = value; }, admin(value) { admin = value; },
    failRead(value) { readError = value; }, failSave(value) { saveError = value; },
    delayRead(value) { waitRead = value; }, delaySave(value) { waitSave = value; },
  };
}
test('unset store is OFF; ADMIN enables/disables only one cloud column and survives reload/login', async () => {
  const f = fixture(); assert.equal(f.state.wholesaleEnabled, false);
  await f.actions.pullWholesaleFeature(); assert.equal(f.state.wholesaleEnabled, false);
  await f.actions.saveWholesaleFeature(true); assert.equal(f.state.wholesaleEnabled, true);
  assert.deepEqual(f.calls.at(-1), { table: 'stores', id: 'A', update: { wholesale_enabled: true } });
  f.actions.resetWholesaleFeature(); assert.equal(f.state.wholesaleEnabled, false);
  await f.actions.pullWholesaleFeature(); assert.equal(f.state.wholesaleEnabled, true);
  await f.actions.saveWholesaleFeature(false); await f.actions.pullWholesaleFeature();
  assert.equal(f.state.wholesaleEnabled, false);
});
test('store A does not enable store B, and a switched store cannot be saved using stale state', async () => {
  const f = fixture(); f.values.set('A', true); await f.actions.pullWholesaleFeature();
  f.store('B'); await f.actions.saveWholesaleFeature(false);
  assert.equal(f.state.wholesaleStatus, 'failed'); assert.equal(f.values.get('A'), true);
  f.actions.resetWholesaleFeature(); await f.actions.pullWholesaleFeature();
  assert.equal(f.state.wholesaleEnabled, false); assert.equal(f.state.wholesaleStoreId, 'B');
});
test('read failure is closed, retry recovers, save failure never reports success', async () => {
  const f = fixture(); f.values.set('A', true); f.failRead(true);
  await f.actions.pullWholesaleFeature(); assert.equal(f.state.wholesaleEnabled, false); assert.equal(f.state.wholesaleStatus, 'failed');
  f.failRead(false); await f.actions.pullWholesaleFeature(); assert.equal(f.state.wholesaleEnabled, true);
  f.failSave(true); await f.actions.saveWholesaleFeature(false);
  assert.equal(f.state.wholesaleEnabled, false); assert.equal(f.state.wholesaleStatus, 'failed'); assert.ok(f.state.wholesaleError);
  await f.actions.pullWholesaleFeature(); assert.equal(f.state.wholesaleEnabled, true);
});
test('only ADMIN saves, duplicate requests coalesce and same-tick toggles are gated', async () => {
  const f = fixture(); const d = deferred(); f.delayRead(d);
  const a = f.actions.pullWholesaleFeature(), b = f.actions.pullWholesaleFeature(); assert.equal(a,b);
  d.resolve(); await a; f.admin(false);
  await assert.rejects(f.actions.saveWholesaleFeature(true), /مدير/);
  assert.equal(f.calls.filter(x => x.update).length, 0);
  f.admin(true); const s = deferred(); f.delaySave(s);
  const save = f.actions.saveWholesaleFeature(true); await f.actions.saveWholesaleFeature(false);
  s.resolve(); await save; assert.equal(f.calls.filter(x => x.update).length, 1);
});
test('late responses after logout/store reset cannot reopen wholesale', async () => {
  const f = fixture(); f.values.set('A', true); const d = deferred(); f.delayRead(d);
  const reading = f.actions.pullWholesaleFeature(); await Promise.resolve();
  f.actions.resetWholesaleFeature(); d.resolve(); await reading;
  assert.equal(f.state.wholesaleEnabled, false); assert.equal(f.state.wholesaleStatus, 'idle');
  f.delayRead(null); await f.actions.pullWholesaleFeature(); const s = deferred(); f.delaySave(s);
  const saving = f.actions.saveWholesaleFeature(true); await Promise.resolve(); f.actions.resetWholesaleFeature(); s.resolve(); await saving;
  assert.equal(f.state.wholesaleEnabled, false); assert.equal(f.state.wholesaleStoreId, null);
});
test('ON grants no new route, sale or return role', () => {
  for (const role of ['ADMIN','ACCOUNTANT','POS_ECOMMERCE','ECOMMERCE_ONLY','MODERATOR']) {
    assert.equal(canAccess(role, '/wholesale'), role === 'ADMIN');
    assert.equal(canSellWholesale(role), ['ADMIN','ACCOUNTANT'].includes(role));
    assert.equal(canReturnWholesale(role), role === 'ADMIN');
  }
});
