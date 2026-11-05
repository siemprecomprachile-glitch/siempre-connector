import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTestEnv, installMocks, subOrder } from './mock-apis.js';

// Sin PARIS_START_AT: asi parte un canal recien configurado.
setTestEnv(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-inicio-')), { parisStartAt: null });
const state = installMocks();

const { processOrder } = await import('../src/core/process.js');
const { tick, sweepChannels } = await import('../src/core/worker.js');
const { salesIdFor } = await import('../src/bsale/documents.js');
const { config } = await import('../src/config.js');
const dbModule = await import('../src/db.js');
const { orders, events } = dbModule;
const db = dbModule.default;

const enUnaHora = () => new Date(Date.now() + 3600 * 1000).toISOString();
const add = (n) => {
  state.parisSubOrders[n] = subOrder(n); // creada hace 1 hora
  return salesIdFor('paris', n);
};

test('sin fecha de inicio: una venta nueva no se registra ni se factura sola', async () => {
  const sid = add('4000000001');
  const r = await processOrder('paris', '4000000001');
  assert.equal(r.status, 'blocked');
  assert.match(r.reason, /PARIS_START_AT/);
  assert.equal(orders.find('paris', '4000000001'), undefined);
  assert.equal(state.postsFor(sid).length, 0);
});

test('canal encendido sin fecha de inicio: el barrido no toca el canal', async () => {
  config.paris.enabled = true;
  const antes = state.parisCalls.length;
  await sweepChannels();
  assert.equal(state.parisCalls.length, antes, 'no se llamo a Paris');
  assert.ok(events.recent(10).some((e) => /sin PARIS_START_AT/.test(e.message)));
  config.paris.enabled = false;
});

test('venta anterior a la fecha de inicio: queda omitida, nunca se factura sola', async () => {
  process.env.PARIS_START_AT = enUnaHora();
  const sid = add('4000000002');
  const r = await processOrder('paris', '4000000002');
  assert.equal(r.status, 'skipped');
  assert.equal(r.reason, 'before_start');
  assert.equal(orders.find('paris', '4000000002').status, 'skipped');
  assert.equal(state.postsFor(sid).length, 0);

  // Otro aviso del mismo pedido tampoco la factura.
  assert.equal((await processOrder('paris', '4000000002')).status, 'skipped');
  assert.equal(state.postsFor(sid).length, 0);
});

test('la misma venta antigua SI se puede facturar con una accion manual explicita', async () => {
  const sid = salesIdFor('paris', '4000000002');
  const r = await processOrder('paris', '4000000002', { manual: true });
  assert.equal(r.status, 'done');
  assert.equal(orders.find('paris', '4000000002').manual_ok, 1);
  assert.equal(state.docsFor(sid).length, 1);
});

test('un reintento de una emision manual no lo frena la fecha de inicio', async () => {
  const sid = add('4000000003');
  state.failNextPost = 'lose-response';
  assert.equal((await processOrder('paris', '4000000003', { manual: true })).status, 'retry');
  db.prepare("UPDATE orders SET next_attempt_at = 0 WHERE external_id = '4000000003'").run();
  await tick(); // reintento automatico
  assert.equal(orders.find('paris', '4000000003').status, 'done');
  assert.equal(state.docsFor(sid).length, 1);
});

test('una emision ya intentada se cierra aunque despues se mueva la fecha de inicio', async () => {
  process.env.PARIS_START_AT = '2020-01-01T00:00:00Z';
  const sid = add('4000000004');
  state.failNextPost = 'lose-response';
  assert.equal((await processOrder('paris', '4000000004')).status, 'retry');
  process.env.PARIS_START_AT = enUnaHora(); // alguien corre la fecha hacia adelante
  db.prepare("UPDATE orders SET next_attempt_at = 0 WHERE external_id = '4000000004'").run();
  await tick();
  assert.equal(orders.find('paris', '4000000004').status, 'done', 'Bsale ya lo tenia: se registra, no se omite');
  assert.equal(state.docsFor(sid).length, 1);
});

test('venta posterior a la fecha de inicio: se factura sola', async () => {
  process.env.PARIS_START_AT = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const sid = add('4000000005');
  assert.equal((await processOrder('paris', '4000000005')).status, 'done');
  assert.equal(state.docsFor(sid).length, 1);
});

test('fecha de inicio invalida = sin fecha (falla segura)', async () => {
  process.env.PARIS_START_AT = 'mañana';
  const r = await processOrder('paris', (add('4000000006'), '4000000006'));
  assert.equal(r.status, 'blocked');
});
