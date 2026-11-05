/**
 * APIs falsas de Bsale, Paris y Walmart para las pruebas. Ninguna prueba sale a
 * internet: cualquier URL que no sea bsale.test / paris.test / walmart.test hace
 * fallar la prueba.
 *
 * El Bsale falso imita lo que documenta Bsale para `salesId`: si ya existe un
 * documento con ese salesId en ese tipo de documento, devuelve el existente en
 * vez de crear uno nuevo. Sin salesId, o con otro tipo, crea uno nuevo.
 */

export function setTestEnv(dataDir, { parisStartAt = '2020-01-01T00:00:00Z' } = {}) {
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
    LIDER_API_URL: 'http://walmart.test',
    LIDER_CLIENT_ID: 'cid',
    LIDER_CLIENT_SECRET: 'csecret',
  });
  if (parisStartAt) process.env.PARIS_START_AT = parisStartAt;
  else delete process.env.PARIS_START_AT;
  delete process.env.PARIS_ENABLED;
  delete process.env.LIDER_ENABLED;
  delete process.env.LIDER_START_AT;
  delete process.env.AUTO_CREDIT_NOTES;
}

/** Orden de Walmart con lineas en los estados indicados. */
export function walmartOrder(id, estados, { price = 11900 } = {}) {
  return {
    purchaseOrderId: id,
    customerOrderId: `C${id}`,
    orderDate: Date.now() - 3600 * 1000,
    shippingInfo: { phone: '+56900000000', postalAddress: { name: 'Ana Rojas', address1: 'Calle 2', city: 'Santiago' } },
    orderLines: {
      orderLine: estados.map((status, i) => ({
        lineNumber: String(i + 1),
        item: { productName: `Producto ${i + 1}`, sku: `W-${i + 1}` },
        orderLineQuantity: { amount: '1' },
        charges: { charge: [{ chargeType: 'PRODUCT', chargeAmount: { amount: price } }] },
        orderLineStatuses: { orderLineStatus: [{ status }] },
      })),
    },
  };
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

/** Respuesta que tarda `ms`; si el cliente corta antes (AbortController), falla como fetch. */
function late(response, ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(response), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    });
  });
}

export function installMocks({ parisSubOrders = {}, walmartOrders = [] } = {}) {
  const state = {
    parisSubOrders,
    parisAuthStatus: 200,
    parisCalls: [],
    walmartOrders,
    walmartCalls: [],
    bsaleDocs: [],
    bsalePosts: [],
    bsaleReturns: [],
    returnPosts: [],
    failNextPost: null, // 'lose-response' | 'reject-400' | 'http-502'
    failNextReturn: null, // 'lose-response' | 'reject-400'
    slowCreateMs: 0, // demora de la respuesta de POST documents (prueba de timeout)
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
      if (u.pathname.endsWith('/offices.json')) return json({ items: [{ id: 1, name: 'Casa Matriz Prueba', state: 0 }] });
      if (u.pathname.endsWith('/taxes.json')) return json({ items: [{ id: 1, name: 'IVA', percentage: '19.0' }] });
      if (u.pathname.endsWith('/documents.json') && method === 'GET') {
        const tipo = Number(u.searchParams.get('documenttypeid'));
        const total = Number(u.searchParams.get('totalamount'));
        return json({
          items: state.bsaleDocs.filter(
            (d) => (!tipo || d.documentTypeId === tipo) && (!total || d.totalAmount === total)
          ),
        });
      }
      const det = u.pathname.match(/\/documents\/(\d+)\/details\.json$/);
      if (det) return json({ items: [{ id: Number(det[1]) * 10, quantity: 1 }] });
      const one = u.pathname.match(/\/documents\/(\d+)\.json$/);
      if (one) {
        const d = state.bsaleDocs.find((x) => x.id === Number(one[1]));
        if (!d) return json({ error: 'no existe' }, 404);
        const { salesId, ...sinSalesId } = d; // como Bsale: el GET no trae salesId
        return json(sinSalesId);
      }
      if (u.pathname.endsWith('/returns.json') && method === 'GET') {
        const ref = Number(u.searchParams.get('referencedocumentid'));
        return json({ items: state.bsaleReturns.filter((r) => r.referenceDocumentId === ref) });
      }
      if (u.pathname.endsWith('/returns.json') && method === 'POST') {
        const body = JSON.parse(init.body);
        state.returnPosts.push(body);
        const mode = state.failNextReturn;
        state.failNextReturn = null;
        if (mode === 'reject-400') return json({ error: 'devolucion invalida' }, 400);
        const id = state.nextId++;
        const ret = { id, referenceDocumentId: body.referenceDocumentId, creditNote: { id: id + 50000, number: 9000 + id } };
        state.bsaleReturns.push(ret);
        if (mode === 'lose-response') throw new TypeError('fetch failed');
        return json(ret, 201);
      }
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
          const neto = (body.details || []).reduce((a, x) => a + Number(x.netUnitValue) * Number(x.quantity), 0);
          doc = {
            id,
            number: 5000 + id,
            documentTypeId: body.documentTypeId,
            salesId: body.salesId ?? null,
            totalAmount: Math.round(neto * 1.19),
            urlPublicView: `https://bsale.test/view/${id}`,
          };
          state.bsaleDocs.push(doc);
        }
        // Bsale ya creo el documento, pero la respuesta no llega al conector.
        if (mode === 'lose-response') throw new TypeError('fetch failed');
        if (mode === 'http-502') return json({ error: 'bad gateway' }, 502);
        if (state.slowCreateMs) return late(json(doc, 201), state.slowCreateMs, init.signal);
        return json(doc, 201);
      }
    }

    if (u.host === 'walmart.test') {
      const h = init.headers || {};
      state.walmartCalls.push({ method, path: u.pathname, market: h.WM_MARKET, version: h.WM_GLOBAL_VERSION, auth: h.Authorization, token: h['WM_SEC.ACCESS_TOKEN'] });
      if (h.WM_MARKET !== 'cl') return json({ error: [{ description: 'WM_MARKET invalido' }] }, 400);
      if (u.pathname === '/v3/token' && method === 'POST') {
        const esperado = 'Basic ' + Buffer.from('cid:csecret').toString('base64');
        if (h.Authorization !== esperado) return json({ error_description: 'credenciales invalidas' }, 401);
        return json({ access_token: 'wm-token', token_type: 'Bearer', expires_in: 900 });
      }
      if (h['WM_SEC.ACCESS_TOKEN'] !== 'wm-token' || h.WM_GLOBAL_VERSION !== '3.1') {
        return json({ error: [{ description: 'token o version invalidos' }] }, 401);
      }
      if (u.pathname === '/v3/orders') return json({ list: { meta: {}, elements: { order: state.walmartOrders } } });
      const m = u.pathname.match(/^\/v3\/orders\/([^/]+)$/);
      if (m) {
        const o = state.walmartOrders.find((x) => x.purchaseOrderId === decodeURIComponent(m[1]));
        return o ? json({ order: o }) : json({ error: [{ description: 'no existe' }] }, 404);
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
