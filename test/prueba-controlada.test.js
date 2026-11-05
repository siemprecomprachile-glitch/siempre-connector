import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4321;
const base = `http://127.0.0.1:${PORT}`;
const T = 'admin-test';
let child;

before(async () => {
  const env = {
    PATH: process.env.PATH,
    PORT: String(PORT),
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sc-http-')),
  };
  child = spawn(process.execPath, ['--import', './test/preload-mocks.js', 'src/index.js'], {
    cwd: repo,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('el servidor no arranco')), 10000);
    child.stdout.on('data', (b) => String(b).includes('server.listening') && (clearTimeout(t), resolve()));
    child.on('exit', (c) => reject(new Error(`salio con ${c}`)));
  });
});
after(() => child?.kill('SIGTERM'));

const health = async () => (await fetch(`${base}/health`)).json();
const emitir = (body, pedido = '3000000001') =>
  fetch(`${base}/panel/prueba/paris/${pedido}/emitir`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: T, ...body }),
  });

test('/health muestra canales apagados, sin fecha de inicio y NC automatica apagada', async () => {
  const h = await health();
  const paris = h.channels.find((c) => c.name === 'paris');
  assert.equal(paris.enabled, false);
  assert.equal(paris.startAt, null);
  assert.equal(h.autoCreditNotes, false);
});

test('sin token no se ve la prueba controlada', async () => {
  assert.equal((await fetch(`${base}/panel/prueba/paris/3000000001`)).status, 401);
});

test('vista previa: muestra tipo, monto y referencia, y no registra nada', async () => {
  const html = await (await fetch(`${base}/panel/prueba/paris/3000000001?token=${T}`)).text();
  assert.match(html, /<b>boleta<\/b>/);
  assert.match(html, /\$11\.900/);
  assert.match(html, /siempre:paris:3000000001/);
  assert.match(html, /no es una simulacion/);
  assert.match(html, /Emitir este documento/);
  assert.deepEqual((await health()).orders, {});
});

test('sin escribir el numero de pedido, no emite', async () => {
  const r = await emitir({ confirm: 'si', expectedKind: 'boleta', expectedTotal: '11900' });
  assert.equal(r.status, 400);
  assert.deepEqual((await health()).orders, {});
});

test('si el monto no coincide con la vista previa, no emite', async () => {
  const r = await emitir({ confirm: '3000000001', expectedKind: 'boleta', expectedTotal: '9990' });
  assert.equal(r.status, 409);
  assert.match(await r.text(), /cambio desde la vista previa/);
  assert.deepEqual((await health()).orders, {});
});

test('con confirmacion correcta emite UN documento, aunque el canal este apagado', async () => {
  const r = await emitir({ confirm: '3000000001', expectedKind: 'boleta', expectedTotal: '11900' });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Emitida boleta N°/);
  assert.deepEqual((await health()).orders, { done: 1 });
});

test('despues: la vista previa muestra el documento y un segundo POST no emite otro', async () => {
  const html = await (await fetch(`${base}/panel/prueba/paris/3000000001?token=${T}`)).text();
  assert.match(html, /ya tiene boleta N°/);
  assert.doesNotMatch(html, /Emitir este documento/);
  const r = await emitir({ confirm: '3000000001', expectedKind: 'boleta', expectedTotal: '11900' });
  assert.equal(r.status, 409);
  assert.deepEqual((await health()).orders, { done: 1 });
});

test('/panel/canales/lider/probar existe y responde con el resumen de estados', async () => {
  const r = await (await fetch(`${base}/panel/canales/lider/probar?token=${T}`)).json();
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.sampleIds, ['A1']);
  assert.equal(r.summary.sinConfirmar, 1);
});

test('/panel/canales/paris/probar existe y responde', async () => {
  const r = await (await fetch(`${base}/panel/canales/paris/probar?token=${T}`)).json();
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.sampleIds.sort(), ['3000000001', '3000000002', '3000000003', '3000000004', '3000000005']);
});

test('canal desconocido: error claro', async () => {
  const r = await fetch(`${base}/panel/canales/ripley/probar?token=${T}`);
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Canal desconocido/);
});

test('ya facturada a mano (un documento menciona el pedido): no muestra boton y el POST no emite', async () => {
  const html = await (await fetch(`${base}/panel/prueba/paris/3000000002?token=${T}`)).text();
  assert.match(html, /Parece ya facturada/);
  assert.match(html, /N° 777/);
  assert.doesNotMatch(html, /Emitir este documento/);
  const r = await emitir({ confirm: '3000000002', expectedKind: 'boleta', expectedTotal: '23800', revisado: 'si' }, '3000000002');
  assert.equal(r.status, 409);
  assert.match(await r.text(), /parece facturada/);
  assert.equal((await health()).orders.done, 1);
});

test('documento parecido: exige marcar que se reviso; con la casilla emite', async () => {
  const html = await (await fetch(`${base}/panel/prueba/paris/3000000003?token=${T}`)).text();
  assert.match(html, /documento\(s\) parecidos/);
  assert.match(html, /name="revisado"/);
  const sin = await emitir({ confirm: '3000000003', expectedKind: 'boleta', expectedTotal: '35700' }, '3000000003');
  assert.equal(sin.status, 409);
  assert.match(await sin.text(), /marca la casilla/);
  assert.equal((await health()).orders.done, 1);
  const con = await emitir({ confirm: '3000000003', expectedKind: 'boleta', expectedTotal: '35700', revisado: 'si' }, '3000000003');
  assert.equal(con.status, 200);
  assert.equal((await health()).orders.done, 2);
});

test('factura sin razon social ni giro: la vista dice que falta y no se puede emitir', async () => {
  const html = await (await fetch(`${base}/panel/prueba/paris/3000000004?token=${T}`)).text();
  assert.match(html, /Falta: razon social, giro/);
  assert.match(html, /No se emite boleta en su lugar/);
  assert.doesNotMatch(html, /Emitir este documento/);
  const r = await emitir({ confirm: '3000000004', expectedKind: 'factura', expectedTotal: '11900', revisado: 'si' }, '3000000004');
  assert.equal(r.status, 409);
  assert.match(await r.text(), /falta razon social, giro.*No se emite boleta/);
  assert.equal((await health()).orders.done, 2);
});

test('si Bsale no responde la revision de ya facturado: no hay boton y el POST no emite', async () => {
  const html = await (await fetch(`${base}/panel/prueba/paris/3000000005?token=${T}`)).text();
  assert.match(html, /No se pudo revisar en Bsale/);
  assert.doesNotMatch(html, /Emitir este documento/);
  const r = await emitir({ confirm: '3000000005', expectedKind: 'boleta', expectedTotal: '55555', revisado: 'si' }, '3000000005');
  assert.equal(r.status, 409);
  assert.match(await r.text(), /no se pudo revisar en Bsale/);
  assert.equal((await health()).orders.done, 2);
});
