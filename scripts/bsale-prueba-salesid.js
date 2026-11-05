#!/usr/bin/env node
/**
 * Valida salesId en la EMPRESA DE PRUEBAS de Bsale.
 *
 * Uso (PowerShell), sin dejar el token en pantalla ni en el historial:
 *   $s = Read-Host "Token de la empresa de PRUEBAS" -AsSecureString
 *   $env:BSALE_TEST_ACCESS_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
 *   node scripts/bsale-prueba-salesid.js
 *   Remove-Item Env:BSALE_TEST_ACCESS_TOKEN
 *
 * Deja el resultado (sin el token) en resultado-salesid.json.
 *
 * No necesita `npm install`: solo usa fetch de Node 18 o superior.
 * Nunca usa BSALE_ACCESS_TOKEN (el real); si son iguales, no se ejecuta.
 */
import fs from 'node:fs';
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
      console.log('\nEmpresa del token:');
      for (const o of cuenta.offices) console.log(`  Sucursal ${o.id}: ${o.name}${o.address ? ' - ' + o.address : ''}`);
      console.log(`  Documentos que ya tiene: ${cuenta.documentosExistentes}`);
      console.log('Si ves tu sucursal real (tu tienda), DETENTE: ese no es el token de pruebas.');
      console.log('La prueba CREA boletas y una factura de prueba (declareSii=0) en esa empresa.');
      const r = await rl.question('Si es la empresa de PRUEBAS, escribe PRUEBA para continuar: ');
      return r.trim() === 'PRUEBA';
    },
  });
  console.log('\n' + JSON.stringify(resultado, null, 2));
  fs.writeFileSync('resultado-salesid.json', JSON.stringify(resultado, null, 2));
  if (resultado.resumen) {
    const r = resultado.resumen;
    console.log('\n=== RESUMEN ===');
    console.log(`Mismo pedido y tipo devuelve el mismo documento: ${r.mismoPedidoMismoTipoDevuelveElMismo ? 'SI' : 'NO'}`);
    console.log(`Reintentos tras corte sin duplicar:               ${r.reintentosTrasCorteSinDuplicar ? 'SI' : 'NO'}`);
    console.log(`Timeout probado de verdad (Bsale lo creo igual):  ${r.timeoutProbadoDeVerdad ? 'SI' : 'NO (ningun corte alcanzo a crear el documento)'}`);
    console.log(`Si cambia el tipo:                                ${r.siCambiaElTipo}`);
    console.log(`El GET devuelve salesId:                          ${r.getDevuelveSalesId ? 'SI' : 'NO'}`);
    console.log('\nResultado guardado en resultado-salesid.json (no contiene el token).');
  }
  process.exitCode = resultado.cancelled ? 1 : resultado.allPassed ? 0 : 2;
} catch (err) {
  console.error('Error:', err.message);
  process.exitCode = 1;
} finally {
  rl.close();
}
