// Se carga con `node --import ./test/preload-mocks.js src/index.js` en las
// pruebas HTTP: el servidor real arranca, pero Bsale/Paris/Walmart son falsos.
import { setTestEnv, installMocks, subOrder, walmartOrder } from './mock-apis.js';

setTestEnv(process.env.DATA_DIR, { parisStartAt: null });
const state = installMocks({
  parisSubOrders: {
    3000000001: subOrder('3000000001'),
    3000000002: subOrder('3000000002', { price: 23800 }), // ya facturada a mano (menciona el pedido)
    3000000003: subOrder('3000000003', { price: 35700 }), // hay un documento parecido
    3000000005: subOrder('3000000005', { price: 55555 }), // Bsale no responde la revision
    3000000004: subOrder('3000000004', {
      factura: true,
      business: { documentNumber: '76.086.428-5' }, // falta razon social y giro
    }),
  },
  walmartOrders: [walmartOrder('A1', ['Acknowledged']), walmartOrder('B1', ['Created'])],
});

state.failSearchTotal = 55555;

// Documentos hechos fuera del conector (sin salesId).
const hoy = Math.floor(Date.now() / 1000);
state.bsaleDocs.push(
  { id: 900, number: 777, documentTypeId: 22, totalAmount: 23800, emissionDate: hoy, salesId: null, details: [{ comment: 'Paris 3000000002' }] },
  { id: 901, number: 778, documentTypeId: 22, totalAmount: 35700, emissionDate: hoy, salesId: null, details: [{ comment: 'Venta mostrador' }] }
);
