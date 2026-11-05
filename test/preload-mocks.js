// Se carga con `node --import ./test/preload-mocks.js src/index.js` en las
// pruebas HTTP: el servidor real arranca, pero Bsale/Paris/Walmart son falsos.
import { setTestEnv, installMocks, subOrder, walmartOrder } from './mock-apis.js';

setTestEnv(process.env.DATA_DIR, { parisStartAt: null });
installMocks({
  parisSubOrders: { 3000000001: subOrder('3000000001') },
  walmartOrders: [walmartOrder('A1', ['Acknowledged']), walmartOrder('B1', ['Created'])],
});
