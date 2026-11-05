#!/usr/bin/env node
/**
 * Valida salesId en la EMPRESA DE PRUEBAS de Bsale.
 *
 * Uso (PowerShell):
 *   $env:BSALE_TEST_ACCESS_TOKEN = "<token de la empresa de pruebas>"
 *   node scripts/bsale-prueba-salesid.js
 *
 * No necesita `npm install`: solo usa fetch de Node 18 o superior.
 * Nunca usa BSALE_ACCESS_TOKEN (el real); si son iguales, no se ejecuta.
 */
import readline from 'node:readline/promises';
import { runSalesIdSelfTest } from '../src/bsale/selftest.js';

const token = process.env.BSALE_TEST_ACCESS_TOKEN;
if (!token) {
  console.error('Define BSALE_TEST_ACCESS_TOKEN con el token de la empresa de PRUEBAS (account.bsale.dev).');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

try {
  const resultado = await runSalesIdSelfTest({
    token,
    realToken: process.env.BSALE_ACCESS_TOKEN,
    apiUrl: process.env.BSALE_TEST_API_URL,
    log: (m) => console.log(m),
    confirm: async (cuenta) => {
      console.log('\nEmpresa del token:', JSON.stringify(cuenta));
      console.log('La prueba CREA boletas y una factura de prueba (declareSii=0) en esa empresa.');
      const r = await rl.question('Si es la empresa de PRUEBAS, escribe PRUEBA para continuar: ');
      return r.trim() === 'PRUEBA';
    },
  });
  console.log('\n' + JSON.stringify(resultado, null, 2));
  process.exitCode = resultado.cancelled ? 1 : resultado.allPassed ? 0 : 2;
} catch (err) {
  console.error('Error:', err.message);
  process.exitCode = 1;
} finally {
  rl.close();
}
