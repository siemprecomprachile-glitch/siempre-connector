import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTestEnv, installMocks, subOrder } from './mock-apis.js';

setTestEnv(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-nc-')));
const state = installMocks();

const { processOrder, processRefund, retryOrder } = await import('../src/core/process.js');
const { tick } = await import('../src/core/worker.js');
const { config } = await import('../src/config.js');
const dbModule = await import('../src/db.js');
const { orders } = dbModule;
const db = dbModule.default;

async function facturada(n) {
  state.parisSubOrders[n] = subOrder(n);
  assert.equal((await processOrder('paris', n)).status, 'done');
  return orders.find('paris', n);
}
const devolucionesDe = (rec) => state.bsaleReturns.filter((r) => r.referenceDocumentId === rec.bsale_document_id);

test('por defecto la NC automatica esta apagada: queda esperando aprobacion', async () => {
  assert.equal(config.rules.autoCreditNotes, false);
  const rec = await facturada('5000000001');
  const r = await processRefund('paris', '5000000001', { refunded: true, motive: 'Cancelada' });
  assert.equal(r.status, 'credit_pending');
  assert.equal(orders.find('paris', '5000000001').status, 'credit_pending');
  assert.equal(devolucionesDe(rec).length, 0);

  // Un aviso posterior del mismo pedido no lo vuelve a facturar.
  const docsAntes = state.bsaleDocs.length;
  await processOrder('paris', '5000000001');
  assert.equal(state.bsaleDocs.length, docsAntes);
});

test('aprobada a mano desde el panel: emite una sola NC', async () => {
  const rec = orders.find('paris', '5000000001');
  const r = await retryOrder(rec.id);
  assert.equal(r.status, 'credited');
  assert.equal(devolucionesDe(rec).length, 1);
  // Volver a apretar no emite otra.
  await processRefund('paris', '5000000001', { motive: 'otra vez' }, { manual: true });
  assert.equal(devolucionesDe(rec).length, 1);
});

test('respuesta perdida al emitir NC: queda en revision y nunca se reintenta sola', async () => {
  config.rules.autoCreditNotes = true;
  const rec = await facturada('5000000002');
  state.failNextReturn = 'lose-response';
  const r = await processRefund('paris', '5000000002', { refunded: true, motive: 'Cancelada' });
  assert.equal(r.status, 'credit_review');
  assert.equal(devolucionesDe(rec).length, 1, 'Bsale alcanzo a crearla');

  db.prepare("UPDATE orders SET updated_at = 0, next_attempt_at = 0 WHERE external_id = '5000000002'").run();
  await tick();
  assert.equal(orders.find('paris', '5000000002').status, 'credit_review');
  assert.equal(state.returnPosts.filter((p) => p.referenceDocumentId === rec.bsale_document_id).length, 1);
});

test('reintento manual tras la revision: Bsale ya tiene la devolucion, no se emite otra', async () => {
  const rec = orders.find('paris', '5000000002');
  const r = await retryOrder(rec.id);
  assert.equal(r.status, 'credit_review');
  assert.match(r.error, /ya tiene 1 devolucion/);
  assert.equal(devolucionesDe(rec).length, 1);
  assert.equal(state.returnPosts.filter((p) => p.referenceDocumentId === rec.bsale_document_id).length, 1);
});

test('rechazo 400 de Bsale: no se creo nada, queda con error para revisar', async () => {
  const rec = await facturada('5000000003');
  state.failNextReturn = 'reject-400';
  const r = await processRefund('paris', '5000000003', { refunded: true, motive: 'Cancelada' });
  assert.equal(r.status, 'credit_failed');
  assert.equal(devolucionesDe(rec).length, 0);
});

test('proceso caido mientras se emitia la NC: pasa a revision sin volver a enviarla', async () => {
  const rec = await facturada('5000000004');
  db.prepare("UPDATE orders SET status = 'credit_processing', updated_at = ? WHERE id = ?").run(
    Date.now() - 11 * 60 * 1000,
    rec.id
  );
  const posts = state.returnPosts.length;
  await tick();
  assert.equal(orders.find('paris', '5000000004').status, 'credit_review');
  assert.equal(state.returnPosts.length, posts);
  config.rules.autoCreditNotes = false;
});
