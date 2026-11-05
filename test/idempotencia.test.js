import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTestEnv, installMocks, subOrder } from './mock-apis.js';

// Las variables tienen que estar antes de cargar config.js.
setTestEnv(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-idem-')));
const state = installMocks();

const { processOrder } = await import('../src/core/process.js');
const { tick } = await import('../src/core/worker.js');
const { issueDocument, salesIdFor } = await import('../src/bsale/documents.js');
const { buildOrder } = await import('../src/core/canonical.js');
const dbModule = await import('../src/db.js');
const { orders } = dbModule;
const db = dbModule.default;

function addSub(n, opts) {
  state.parisSubOrders[n] = subOrder(n, opts);
  return salesIdFor('paris', n);
}
function dueNow(n) {
  const rec = orders.find('paris', n);
  db.prepare('UPDATE orders SET next_attempt_at = 0 WHERE id = ?').run(rec.id);
}

test('control: el Bsale falso solo deduplica con el mismo salesId y el mismo tipo', async () => {
  const order = buildOrder({
    channel: 'paris',
    externalId: 'CTRL',
    total: 11900,
    items: [{ name: 'x', quantity: 1, unitPrice: 11900 }],
  });
  await issueDocument(order, { docKind: 'boleta', salesId: 'ctrl-1' });
  await issueDocument(order, { docKind: 'boleta', salesId: 'ctrl-1' });
  assert.equal(state.docsFor('ctrl-1').length, 1, 'mismo salesId y tipo: un documento');
  await issueDocument(order, { docKind: 'boleta' });
  await issueDocument(order, { docKind: 'boleta' });
  assert.equal(state.bsaleDocs.filter((d) => d.salesId === null).length, 2, 'sin salesId: duplica');
});

test('respuesta perdida: Bsale creo el documento, el reintento no emite otro', async () => {
  const sid = addSub('1000000001');
  state.failNextPost = 'lose-response';

  const r1 = await processOrder('paris', '1000000001');
  assert.equal(r1.status, 'retry');
  assert.equal(state.docsFor(sid).length, 1, 'Bsale alcanzo a crearlo');

  dueNow('1000000001');
  await tick();

  const rec = orders.find('paris', '1000000001');
  assert.equal(rec.status, 'done');
  assert.equal(state.docsFor(sid).length, 1, 'sigue habiendo un solo documento');
  assert.equal(rec.bsale_document_id, state.docsFor(sid)[0].id);
  const posts = state.postsFor(sid);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].documentTypeId, posts[1].documentTypeId);
});

test('502 de Bsale despues de crear: tampoco duplica', async () => {
  const sid = addSub('1000000006');
  state.failNextPost = 'http-502';
  assert.equal((await processOrder('paris', '1000000006')).status, 'retry');
  dueNow('1000000006');
  await tick();
  assert.equal(orders.find('paris', '1000000006').status, 'done');
  assert.equal(state.docsFor(sid).length, 1);
});

test('proceso caido entre "Bsale lo creo" y "SQLite lo guardo": se retoma sin duplicar', async () => {
  const sid = addSub('1000000002');
  const realUpdate = orders.update;
  let muerto = false;
  orders.update = function (id, fields) {
    if (muerto) throw new Error('proceso caido');
    if (fields.status === 'done') {
      muerto = true;
      throw new Error('proceso caido');
    }
    return realUpdate.call(this, id, fields);
  };
  await assert.rejects(processOrder('paris', '1000000002'));
  orders.update = realUpdate;

  let rec = orders.find('paris', '1000000002');
  assert.equal(rec.status, 'processing', 'quedo a medio camino');
  assert.equal(state.docsFor(sid).length, 1, 'pero Bsale ya tenia el documento');

  // Antes del arreglo nadie retomaba una orden "processing". Ahora, pasados
  // 10 minutos, el worker la toma y Bsale devuelve el documento existente.
  db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(Date.now() - 11 * 60 * 1000, rec.id);
  await tick();

  rec = orders.find('paris', '1000000002');
  assert.equal(rec.status, 'done');
  assert.equal(state.docsFor(sid).length, 1);
  assert.equal(rec.bsale_document_id, state.docsFor(sid)[0].id);
});

test('el reintento no cambia boleta por factura (eso emitiria un segundo documento)', async () => {
  const sid = addSub('1000000003');
  state.failNextPost = 'lose-response';
  assert.equal((await processOrder('paris', '1000000003')).status, 'retry');

  // Entre intentos el pedido cambia y ahora pediria factura.
  state.parisSubOrders['1000000003'] = subOrder('1000000003', { factura: true });
  dueNow('1000000003');
  await tick();

  const rec = orders.find('paris', '1000000003');
  assert.equal(rec.status, 'done');
  assert.equal(rec.doc_kind, 'boleta');
  assert.deepEqual(state.postsFor(sid).map((p) => p.documentTypeId), [22, 22]);
  assert.equal(state.docsFor(sid).length, 1);
});

test('rechazo 400 de Bsale: no se creo nada y el tipo queda libre', async () => {
  const sid = addSub('1000000004');
  state.failNextPost = 'reject-400';
  const r = await processOrder('paris', '1000000004');
  assert.equal(r.status, 'failed');
  assert.equal(state.docsFor(sid).length, 0);
  assert.equal(orders.find('paris', '1000000004').emit_doc_kind, null);
});

test('base borrada (disco efimero): Bsale devuelve el documento que ya existia', async () => {
  const sid = addSub('1000000005');
  assert.equal((await processOrder('paris', '1000000005')).status, 'done');
  const first = orders.find('paris', '1000000005').bsale_document_id;

  db.prepare("DELETE FROM orders WHERE channel = 'paris' AND external_id = '1000000005'").run();
  assert.equal((await processOrder('paris', '1000000005')).status, 'done');

  assert.equal(state.docsFor(sid).length, 1);
  assert.equal(orders.find('paris', '1000000005').bsale_document_id, first);
});

test('todos los documentos enviados llevan declareSii=0 en modo prueba', () => {
  assert.ok(state.bsalePosts.length > 0);
  assert.ok(state.bsalePosts.every((p) => p.declareSii === 0));
});
