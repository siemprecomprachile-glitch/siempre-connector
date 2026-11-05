import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTestEnv, installMocks, walmartOrder } from './mock-apis.js';

setTestEnv(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-lider-')));
const state = installMocks({
  walmartOrders: [
    walmartOrder('A1', ['Acknowledged']),
    walmartOrder('B1', ['Created']),
    walmartOrder('C1', ['Cancelled']),
    walmartOrder('D1', ['Shipped', 'Canceled']),
    walmartOrder('E1', ['Created', 'Acknowledged']),
  ],
});

const { probeChannel, previewOrder } = await import('../src/core/diagnostics.js');
const { liderChannel } = await import('../src/channels/lider/index.js');
const { config } = await import('../src/config.js');
const { orders } = await import('../src/db.js');

test('credenciales malas: probar informa el error del token', async () => {
  const real = config.lider.clientSecret;
  config.lider.clientSecret = 'otra';
  const r = await probeChannel('lider');
  assert.equal(r.ok, false);
  assert.match(r.error, /Lider token 401/);
  config.lider.clientSecret = real;
});

test('/panel/canales/lider/probar: autentica y lista solo las ordenes facturables', async () => {
  const r = await probeChannel('lider');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.enabled, false);
  assert.deepEqual(r.sampleIds, ['A1', 'D1']);
  assert.deepEqual(r.summary, { recibidas: 5, facturables: 2, sinConfirmar: 2, canceladas: 1 });
  assert.deepEqual(orders.counts(), {}, 'no registra nada');
  assert.equal(state.bsalePosts.length, 0, 'no emite nada');
});

test('cabeceras de Walmart Chile: WM_MARKET=cl en todo y WM_GLOBAL_VERSION=3.1 en las APIs', () => {
  assert.ok(state.walmartCalls.length > 0);
  assert.ok(state.walmartCalls.every((c) => c.market === 'cl'));
  const token = state.walmartCalls.filter((c) => c.path === '/v3/token');
  assert.ok(token.every((c) => c.auth.startsWith('Basic ')));
  const apis = state.walmartCalls.filter((c) => c.path !== '/v3/token');
  assert.ok(apis.every((c) => c.version === '3.1' && c.token === 'wm-token'));
});

test('estados: Created espera, todo cancelado se omite, linea cancelada no se factura', async () => {
  assert.match((await liderChannel.fetchOrder('B1')).retryLater, /Created/);
  assert.match((await liderChannel.fetchOrder('E1')).retryLater, /Created/);
  assert.match((await liderChannel.fetchOrder('C1')).skip, /canceladas/);

  const d = await liderChannel.fetchOrder('D1');
  assert.equal(d.canonical.items.length, 1, 'la linea "Canceled" (una L) queda fuera');
  assert.equal(d.canonical.total, 11900);
});

test('vista previa Lider: boleta con salesId, sin enviar nada a Bsale', async () => {
  const p = await previewOrder('lider', 'A1');
  assert.equal(p.docKind, 'boleta');
  assert.equal(p.payload.salesId, 'siempre:lider:A1');
  assert.equal(p.sentToBsale, false);
  assert.equal(state.bsalePosts.length, 0);
});
