import crypto from 'node:crypto';
import { config } from '../../config.js';
import { buildOrder } from '../../core/canonical.js';
import { formatRut } from '../../core/rut.js';
import { log } from '../../logger.js';

/**
 * Lider / Walmart Chile Marketplace.
 *
 * Segun la documentacion de Walmart (developer.walmart.com, Chile y Global):
 *  - Host unico para todos los paises: https://marketplace.walmartapis.com.
 *    El pais se elige con la cabecera WM_MARKET=cl. Las APIs legacy de Chile
 *    estan en retiro; las Global piden ademas WM_GLOBAL_VERSION=3.1.
 *  - Token: POST /v3/token, Basic base64(ClientID:ClientSecret),
 *    grant_type=client_credentials. Dura 15 MINUTOS.
 *  - Credenciales: Developer Portal > Marketplace (US, Mexico, Canada y Chile)
 *    > API Keys > Production Keys. Solo el rol Administrador ve el Secret.
 *  - Ordenes: GET /v3/orders (createdStartDate ISO-8601, limit) y
 *    GET /v3/orders/{purchaseOrderId}. Sin webhooks: se consulta cada X min.
 *  - Estados de linea: Created (nueva, falta confirmarla), Acknowledged
 *    (confirmada por ti), Shipped, Delivered, Cancelled/Canceled.
 */
const ENDPOINTS = {
  token: '/v3/token',
  orders: '/v3/orders',
  order: (id) => `/v3/orders/${encodeURIComponent(id)}`,
};

/** Se factura cuando la venta esta confirmada. Created todavia no. */
const BILLABLE = ['Acknowledged', 'Shipped', 'Delivered'];

/** Estado de una linea (la API lo entrega como lista). */
export function lineStatus(line) {
  const estados = line?.orderLineStatuses?.orderLineStatus || [];
  const lista = Array.isArray(estados) ? estados : [estados];
  return String(lista[lista.length - 1]?.status || lista[0]?.status || '');
}

const isCancelled = (status) => /cancel/i.test(status); // "Cancelled" y "Canceled"

function linesOf(order) {
  const lines = order?.orderLines?.orderLine || order?.orderLines || [];
  return Array.isArray(lines) ? lines : [lines];
}

/**
 * Que hacer con una orden segun sus lineas:
 *  'skip'  todas canceladas
 *  'wait'  hay lineas activas sin confirmar (Created): se espera
 *  'bill'  todas las lineas activas estan confirmadas o despachadas
 */
export function billingState(order) {
  const activas = linesOf(order).filter((l) => !isCancelled(lineStatus(l)));
  if (!activas.length) return 'skip';
  if (activas.every((l) => BILLABLE.includes(lineStatus(l)))) return 'bill';
  return 'wait';
}

let cachedToken = null; // { value, expiresAt }

async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;

  if (!config.lider.clientId || !config.lider.clientSecret) {
    const err = new Error('Falta LIDER_CLIENT_ID / LIDER_CLIENT_SECRET en el .env');
    err.permanent = true;
    throw err;
  }

  const basic = Buffer.from(`${config.lider.clientId}:${config.lider.clientSecret}`).toString(
    'base64'
  );

  const res = await fetch(`${config.lider.apiUrl}${ENDPOINTS.token}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...walmartHeaders(),
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`Lider token ${res.status}: ${data?.error_description || res.statusText}`);
    err.permanent = res.status === 401 || res.status === 403;
    throw err;
  }

  // El token dura 900s; se guarda con 60s de margen.
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + ((Number(data.expires_in) || 900) - 60) * 1000,
  };
  log.debug('lider.token_renovado');
  return cachedToken.value;
}

/** Cabeceras que Walmart pide en cada llamada (Chile + APIs Global). */
function walmartHeaders() {
  const h = {
    'WM_SVC.NAME': 'Walmart Marketplace',
    'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
    WM_MARKET: config.lider.market,
  };
  if (config.lider.channelType) h['WM_CONSUMER.CHANNEL.TYPE'] = config.lider.channelType;
  return h;
}

async function call(path) {
  const token = await getToken();
  const res = await fetch(`${config.lider.apiUrl}${path}`, {
    headers: {
      Accept: 'application/json',
      'WM_SEC.ACCESS_TOKEN': token,
      WM_GLOBAL_VERSION: config.lider.globalVersion,
      ...walmartHeaders(),
    },
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Si el token murio antes de tiempo, se descarta y el reintento lo renueva.
    if (res.status === 401) cachedToken = null;
    const err = new Error(`Lider ${res.status}: ${data?.error?.[0]?.description || res.statusText}`);
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429;
    throw err;
  }
  return data;
}

function unwrapOrders(data) {
  return (
    data?.list?.elements?.order ||
    data?.elements?.order ||
    data?.order ||
    (Array.isArray(data) ? data : [])
  );
}

function extractRut(order) {
  const addr = order.shippingInfo?.postalAddress || {};
  // Walmart no tiene un campo de RUT propio: segun la configuracion de la
  // cuenta viene en la segunda linea de direccion o en un campo fiscal.
  const candidatos = [
    order.taxId,
    order.customerTaxId,
    addr.address2,
    addr.addressLineTwo,
    addr.company,
    order.customerId,
  ];
  for (const c of candidatos) {
    const rut = formatRut(c);
    if (rut) return rut;
  }
  return null;
}

export function toCanonicalOrder(order) {
  const addr = order.shippingInfo?.postalAddress || {};
  const activas = linesOf(order).filter((l) => !isCancelled(lineStatus(l)));

  const items = activas.map((l) => {
    const cargos = l.charges?.charge || [];
    const lista = Array.isArray(cargos) ? cargos : [cargos];
    const producto = lista.find((c) => c.chargeType === 'PRODUCT') || lista[0] || {};
    return {
      sku: l.item?.sku || null,
      name: l.item?.productName || 'Producto',
      quantity: Number(l.orderLineQuantity?.amount) || 1,
      unitPrice: Number(producto.chargeAmount?.amount) || 0,
      discount: 0,
    };
  });

  const shippingCost = activas.reduce((acc, l) => {
    const cargos = l.charges?.charge || [];
    const lista = Array.isArray(cargos) ? cargos : [cargos];
    const envio = lista.find((c) => /SHIPPING/i.test(c.chargeType || ''));
    return acc + (Number(envio?.chargeAmount?.amount) || 0);
  }, 0);

  return buildOrder({
    channel: 'lider',
    externalId: order.purchaseOrderId || order.customerOrderId,
    reference: `Lider #${order.customerOrderId || order.purchaseOrderId}`,
    createdAt: order.orderDate ? new Date(Number(order.orderDate) || order.orderDate) : new Date(),
    paid: true, // Walmart entrega la orden ya pagada.
    currency: 'CLP',
    total: items.reduce((acc, i) => acc + i.unitPrice * i.quantity, 0) + shippingCost,
    shippingCost,
    customer: {
      rut: extractRut(order),
      name: addr.name || order.customerName || 'Consumidor Final',
      businessName: null,
      activity: null,
      email: order.customerEmailId || null,
      phone: order.shippingInfo?.phone || null,
      address: [addr.address1, addr.address2].filter(Boolean).join(' ') || null,
      city: addr.city || null,
      municipality: addr.city || null,
    },
    items,
  });
}

export const liderChannel = {
  name: 'lider',
  label: 'Lider',
  get enabled() {
    return config.lider.enabled;
  },

  async fetchOrder(orderId) {
    const data = await call(ENDPOINTS.order(orderId));
    const order = unwrapOrders(data)[0] || data?.order || data;
    if (!order) {
      const err = new Error(`Lider no devolvio la orden ${orderId}`);
      err.permanent = true;
      throw err;
    }
    const estado = billingState(order);
    if (estado === 'skip') return { skip: 'todas las lineas estan canceladas', raw: order };
    if (estado === 'wait') {
      return { retryLater: 'Orden sin confirmar en Walmart (Created): se factura al quedar Acknowledged', raw: order };
    }
    return { canonical: toCanonicalOrder(order), raw: order };
  },

  /**
   * Solo devuelve ordenes listas para facturar (todas sus lineas activas
   * Acknowledged/Shipped/Delivered). Las Created no se registran: el proximo
   * barrido las toma cuando se confirmen (si siguen dentro de las 48 h).
   */
  async listRecentOrderIds(limit = 50) {
    const orders = await recentOrders(limit);
    const ids = orders
      .filter((o) => billingState(o) === 'bill')
      .map((o) => String(o.purchaseOrderId || o.customerOrderId));
    log.debug('lider.sweep', { recibidas: orders.length, facturables: ids.length });
    return ids;
  },

  /** Para el diagnostico: cuantas ordenes hay en cada estado. */
  async recentOrderSummary(limit = 50) {
    const orders = await recentOrders(limit);
    const porEstado = {};
    for (const o of orders) {
      const e = billingState(o);
      porEstado[e] = (porEstado[e] || 0) + 1;
    }
    return { recibidas: orders.length, facturables: porEstado.bill || 0, sinConfirmar: porEstado.wait || 0, canceladas: porEstado.skip || 0 };
  },
};

async function recentOrders(limit) {
  const desde = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const params = new URLSearchParams({ createdStartDate: desde, limit: String(limit) });
  return unwrapOrders(await call(`${ENDPOINTS.orders}?${params}`));
}
