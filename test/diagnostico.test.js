import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTestEnv, installMocks, subOrder } from './mock-apis.js';

setTestEnv(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-diag-')));
const state = installMocks({
  parisSubOrders: { 2000000001: subOrder('2000000001'), 2000000002: subOrder('2000000002', { factura: true }) },
});

const { probeChannel, previewOrder } = await import('../src/core/diagnostics.js');
const { sweepChannels } = await import('../src/core/worker.js');
const { enabledChannels } = await import('../src/channels/index.js');
const { resetSession } = await import('../src/channels/paris/index.js');
const { orders } = await import('../src/db.js');

test('con PARIS_ENABLED sin definir, Paris queda apagado y el barrido no lo toca', async () => {
  assert.ok(!enabledChannels().some((c) => c.name === 'paris'));
  const antes = state.parisCalls.length;
  await sweepChannels();
  assert.equal(state.parisCalls.length, antes, 'el barrido no llamo a Paris');
});

test('probar: autentica y lista pedidos sin registrarlos ni emitir', async () => {
  const r = await probeChannel('paris');
  assert.equal(r.ok, true);
  assert.equal(r.enabled, false);
  assert.equal(r.found, 2);
  assert.deepEqual(r.sampleIds, ['2000000001', '2000000002']);
  assert.ok(state.parisCalls.includes('POST /v1/auth/apiKey'));
  assert.equal(state.bsalePosts.length, 0);
  assert.deepEqual(orders.counts(), {});
});

test('vista previa: arma el documento con salesId, sin enviarlo a Bsale', async () => {
  const b = await previewOrder('paris', '2000000001');
  assert.equal(b.sentToBsale, false);
  assert.equal(b.docKind, 'boleta');
  assert.equal(b.payload.documentTypeId, 22);
  assert.equal(b.payload.salesId, 'siempre:paris:2000000001');
  assert.equal(b.payload.declareSii, 0);

  const f = await previewOrder('paris', '2000000002');
  assert.equal(f.docKind, 'factura');
  assert.equal(f.payload.documentTypeId, 5);

  assert.equal(state.bsalePosts.length, 0, 'ningun POST a Bsale');
  assert.ok(!state.parisCalls.some((c) => c.startsWith('POST /v1/invoice')), 'nada subido a Paris');
  assert.deepEqual(orders.counts(), {}, 'ninguna venta registrada');
});

test('credenciales malas: probar informa el error sin reventar', async () => {
  resetSession();
  state.parisAuthStatus = 401;
  const r = await probeChannel('paris');
  assert.equal(r.ok, false);
  assert.match(r.error, /Paris auth 401/);
  state.parisAuthStatus = 200;
});
