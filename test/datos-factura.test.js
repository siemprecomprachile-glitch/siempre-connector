import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTestEnv, installMocks, subOrder, walmartOrder } from './mock-apis.js';

setTestEnv(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-datos-')));
process.env.LIDER_START_AT = '2020-01-01T00:00:00Z';
const state = installMocks({
  walmartOrders: [
    walmartOrder('EMP1', ['Acknowledged'], { rut: '76.086.428-5' }), // RUT de empresa, sin razon social
    walmartOrder('PER1', ['Acknowledged'], { rut: '11.111.111-1' }), // RUT de persona
  ],
});

const { processOrder, retryOrder } = await import('../src/core/process.js');
const { previewOrder } = await import('../src/core/diagnostics.js');
const { decideDocKind } = await import('../src/bsale/documents.js');
const { liderChannel } = await import('../src/channels/lider/index.js');
const { orders } = await import('../src/db.js');

test('RUT de empresa sin razon social: sigue siendo factura (no cambia a boleta)', async () => {
  const { canonical } = await liderChannel.fetchOrder('EMP1');
  assert.equal(decideDocKind(canonical), 'factura');
});

test('vista previa: bloquea y dice que dato falta', async () => {
  const p = await previewOrder('lider', 'EMP1');
  assert.equal(p.docKind, 'factura');
  assert.equal(p.payload, null);
  assert.deepEqual(p.blocked.missing, ['razon social', 'giro']);
  assert.match(p.blocked.message, /No se emite boleta en su lugar/);
  assert.equal(state.bsalePosts.length, 0);
});

test('emision: queda "falta dato", no envia nada a Bsale y no se reintenta sola', async () => {
  const r = await processOrder('lider', 'EMP1');
  assert.equal(r.status, 'needs_data');
  assert.deepEqual(r.missing, ['razon social', 'giro']);
  const rec = orders.find('lider', 'EMP1');
  assert.equal(rec.status, 'needs_data');
  assert.match(rec.last_error, /Factura bloqueada: falta razon social, giro del RUT 76086428-5/);
  assert.equal(state.bsalePosts.length, 0);
  assert.equal(orders.dueForRetry(50).some((o) => o.id === rec.id), false);
});

test('reintento manual sin completar el dato: sigue bloqueada, nunca emite boleta', async () => {
  const rec = orders.find('lider', 'EMP1');
  const r = await retryOrder(rec.id);
  assert.equal(r.status, 'needs_data');
  assert.equal(state.bsalePosts.length, 0);
});

test('RUT de persona sin razon social: boleta normal', async () => {
  assert.equal((await processOrder('lider', 'PER1')).status, 'done');
  assert.equal(state.bsalePosts.at(-1).documentTypeId, 22);
});

test('Paris: el comprador pidio factura pero falta el giro -> bloqueada', async () => {
  state.parisSubOrders['6000000001'] = subOrder('6000000001', {
    factura: true,
    business: { documentNumber: '76.086.428-5', businessName: 'Barberia SpA' },
  });
  const antes = state.bsalePosts.length;
  const r = await processOrder('paris', '6000000001');
  assert.equal(r.status, 'needs_data');
  assert.deepEqual(r.missing, ['giro']);
  assert.equal(state.bsalePosts.length, antes);

  // Con el dato completo en el canal, el reintento emite la factura.
  state.parisSubOrders['6000000001'] = subOrder('6000000001', { factura: true });
  const ok = await retryOrder(orders.find('paris', '6000000001').id);
  assert.equal(ok.status, 'done');
  assert.equal(state.bsalePosts.at(-1).documentTypeId, 5);
});
