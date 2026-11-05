/**
 * APIs falsas de Bsale y Paris para las pruebas. Ninguna prueba sale a internet:
 * cualquier URL que no sea bsale.test / paris.test hace fallar la prueba.
 *
 * El Bsale falso imita lo que documenta Bsale para `salesId`: si ya existe un
 * documento con ese salesId en ese tipo de documento, devuelve el existente en
 * vez de crear uno nuevo. Sin salesId, o con otro tipo, crea uno nuevo.
 */

export function setTestEnv(dataDir) {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    ADMIN_TOKEN: 'admin-test',
    BSALE_ACCESS_TOKEN: 'bsale-test',
    BSALE_API_URL: 'http://bsale.test/v1',
    BSALE_DECLARE_SII: '0',
    PARIS_API_URL: 'http://paris.test',
    PARIS_API_KEY: 'paris-test',
    PARIS_SELLER_ID: 'S1',
  });
  delete process.env.PARIS_ENABLED;
  delete process.env.LIDER_ENABLED;
}

export function subOrder(n, { factura = false } = {}) {
  return {
    subOrderNumber: n,
    originOrderDate: new Date(Date.now() - 3600 * 1000).toISOString(),
    originInvoiceType: factura ? 'factura' : 'boleta',
    customer: {
      name: 'Juan Perez',
      documentType: 'RUT',
      documentNumber: '11.111.111-1',
      email: 'juan@example.cl',
    },
    businessInvoice: factura
      ? { documentNumber: '76.086.428-5', businessName: 'Barberia SpA', activity: 'Peluqueria' }
      : null,
    billingAddress: { address1: 'Calle 1', city: 'Santiago', phone: '+56900000000' },
    items: [{ sellerSku: 'SKU-1', name: 'Maquina de corte', basePrice: 11900 }],
    dispatchCost: 0,
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function installMocks({ parisSubOrders = {} } = {}) {
  const state = {
    parisSubOrders,
    parisAuthStatus: 200,
    parisCalls: [],
    bsaleDocs: [],
    bsalePosts: [],
    failNextPost: null, // 'lose-response' | 'reject-400' | 'http-502'
    nextId: 1000,
  };

  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input));
    const method = String(init.method || 'GET').toUpperCase();

    if (u.host === 'bsale.test') {
      if (u.pathname.endsWith('/document_types.json')) {
        return json({ items: [{ id: 22, codeSii: 39 }, { id: 5, codeSii: 33 }, { id: 2, codeSii: 61 }] });
      }
      if (u.pathname.endsWith('/variants.json')) return json({ items: [] });
      if (u.pathname.endsWith('/documents.json') && method === 'POST') {
        const body = JSON.parse(init.body);
        state.bsalePosts.push(body);
        const mode = state.failNextPost;
        state.failNextPost = null;
        if (mode === 'reject-400') return json({ error: 'documento invalido' }, 400);

        let doc =
          body.salesId &&
          state.bsaleDocs.find(
            (d) => d.salesId === body.salesId && d.documentTypeId === body.documentTypeId
          );
        if (!doc) {
          const id = state.nextId++;
          doc = {
            id,
            number: 5000 + id,
            documentTypeId: body.documentTypeId,
            salesId: body.salesId ?? null,
            urlPublicView: `https://bsale.test/view/${id}`,
          };
          state.bsaleDocs.push(doc);
        }
        // Bsale ya creo el documento, pero la respuesta no llega al conector.
        if (mode === 'lose-response') throw new TypeError('fetch failed');
        if (mode === 'http-502') return json({ error: 'bad gateway' }, 502);
        return json(doc, 201);
      }
    }

    if (u.host === 'paris.test') {
      state.parisCalls.push(`${method} ${u.pathname}`);
      if (u.pathname === '/v1/auth/apiKey') {
        if (state.parisAuthStatus !== 200) return json({ message: 'API key invalida' }, state.parisAuthStatus);
        return json({ accessToken: 'paris-token', expiresIn: 14400, jwtPayload: { seller_id: 'S1' } });
      }
      if (u.pathname === '/v3/sub-orders') {
        return json({ data: Object.keys(state.parisSubOrders).map((n) => ({ subOrderNumber: n })) });
      }
      const m = u.pathname.match(/^\/v3\/sub-orders\/([^/]+)\/detail$/);
      if (m) {
        const sub = state.parisSubOrders[decodeURIComponent(m[1])];
        return sub ? json(sub) : json({ message: 'no existe' }, 404);
      }
      if (u.pathname === '/v1/invoice' && method === 'POST') return json({ ok: true });
    }

    throw new Error(`Prueba intento salir a una URL no simulada: ${method} ${u}`);
  };

  state.docsFor = (salesId) => state.bsaleDocs.filter((d) => d.salesId === salesId);
  state.postsFor = (salesId) => state.bsalePosts.filter((p) => p.salesId === salesId);
  return state;
}
