import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTestEnv, installMocks, subOrder } from './mock-apis.js';

setTestEnv(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ya-')));
const state = installMocks();
const { previewOrder } = await import('../src/core/diagnostics.js');

const hoy = Math.floor(Date.now() / 1000);
// Documentos hechos a mano o por otra integracion: SIN salesId.
const manual = (id, total, comment, extra = {}) =>
  state.bsaleDocs.push({ id, number: 700 + id, documentTypeId: 22, totalAmount: total, emissionDate: hoy, salesId: null, details: [{ quantity: 1, comment }], ...extra });

test('sin documentos parecidos: la revision sale limpia', async () => {
  state.parisSubOrders['7000000001'] = subOrder('7000000001', { price: 15000, rut: '12.345.678-5' });
  const p = await previewOrder('paris', '7000000001');
  assert.equal(p.existingCheck.ok, true);
  assert.deepEqual(p.existingCheck.candidates, []);
});

test('documento manual que menciona el pedido: se marca como ya facturado', async () => {
  state.parisSubOrders['7000000002'] = subOrder('7000000002', { price: 23800 });
  manual(1, 23800, 'Venta Paris sub-orden 7000000002');
  const p = await previewOrder('paris', '7000000002');
  assert.equal(p.existingCheck.candidates.length, 1);
  assert.equal(p.existingCheck.candidates[0].mentionsOrder, true);
  assert.equal(p.existingCheck.candidates[0].number, 701);
});

test('mismo monto pero no menciona el pedido: aparece como parecido, no como seguro', async () => {
  state.parisSubOrders['7000000003'] = subOrder('7000000003', { price: 35700 });
  manual(2, 35700, 'Venta mostrador');
  const p = await previewOrder('paris', '7000000003');
  assert.equal(p.existingCheck.candidates.length, 1);
  assert.equal(p.existingCheck.candidates[0].mentionsOrder, false);
});

test('mismo RUT con otro monto tambien aparece', async () => {
  state.parisSubOrders['7000000004'] = subOrder('7000000004', { price: 9990, rut: '9.876.543-3' });
  manual(3, 5000, 'Factura manual', { clientCode: '9876543-3' });
  const p = await previewOrder('paris', '7000000004');
  assert.deepEqual(p.existingCheck.candidates.map((c) => c.id), [3]);
});

test('documento fuera del rango de fechas no aparece', async () => {
  state.parisSubOrders['7000000005'] = subOrder('7000000005', { price: 44440 });
  manual(4, 44440, 'Vieja', { emissionDate: hoy - 60 * 86400 });
  const p = await previewOrder('paris', '7000000005');
  assert.deepEqual(p.existingCheck.candidates, []);
});

test('si Bsale no responde, la revision queda como no verificada', async () => {
  state.parisSubOrders['7000000006'] = subOrder('7000000006');
  const real = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    if (String(u).includes('/documents.json?totalamount')) throw new TypeError('fetch failed');
    return real(u, init);
  };
  const p = await previewOrder('paris', '7000000006');
  globalThis.fetch = real;
  assert.equal(p.existingCheck.ok, false);
  assert.match(p.existingCheck.error, /red hacia Bsale/);
});

test('la revision solo lee: ningun POST a Bsale', () => {
  assert.equal(state.bsalePosts.length, 0);
});
