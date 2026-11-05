import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMocks } from './mock-apis.js';
import { runSalesIdSelfTest } from '../src/bsale/selftest.js';

// El script real corre contra la empresa de pruebas de Bsale. Aca se prueba
// contra el Bsale falso, que imita lo documentado para salesId.
const state = installMocks();
const opts = { token: 'token-prueba', apiUrl: 'http://bsale.test/v1', pauseMs: 10, timeouts: [5, 200] };

test('no corre si el token de prueba es igual al real', async () => {
  await assert.rejects(runSalesIdSelfTest({ ...opts, realToken: 'token-prueba' }), /igual a BSALE_ACCESS_TOKEN/);
  assert.equal(state.bsalePosts.length, 0);
});

test('si no se confirma la empresa, no crea nada', async () => {
  const r = await runSalesIdSelfTest({ ...opts, confirm: async () => false });
  assert.equal(r.cancelled, true);
  assert.equal(state.bsalePosts.length, 0);
});

test('ejecuta A-D y reporta lo que hace Bsale', async () => {
  state.slowCreateMs = 30; // el corte a los 5 ms llega despues de que Bsale lo creo
  const r = await runSalesIdSelfTest(opts);
  state.slowCreateMs = 0;
  const paso = (p) => r.steps.find((s) => s.name.startsWith(p));

  assert.equal(paso('A.').pass, true);
  const b5 = r.steps.find((s) => s.name.includes('5 ms'));
  assert.equal(b5.detail.primerEnvioCortado, true);
  assert.equal(b5.pass, true, 'cortado y reintentado: un solo documento');
  assert.match(paso('C.').detail.resultado, /NUEVO/);
  assert.equal(paso('D.').detail.trae, false);
  assert.equal(r.allPassed, true);
  assert.ok(state.bsalePosts.every((p) => p.declareSii === 0));
});
