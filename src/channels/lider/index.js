import crypto from 'node:crypto';
import { config } from '../../config.js';
import { buildOrder } from '../../core/canonical.js';
import { formatRut } from '../../core/rut.js';
import { log } from '../../logger.js';

/**
 * Lider / Walmart Chile Marketplace.
 *
 * Credenciales: Client ID + Client Secret del developer portal de Walmart.
 * El token dura 15 MINUTOS, asi que se pide uno nuevo casi en cada barrido.
 * Tampoco hay webhooks: se consulta cada X minutos.
 *
 * Igual que en Paris, todas las rutas y estados estan en este bloque.
 */
const ENDPOINTS = {
  token: '/v3/token',
  orders: '/v3/orders',
  order: (id) => `/v3/orders/${encodeURIComponent(id)}`,
  billableStatuses: ['Acknowledged', 'Shipped', 'Delivered'],
};

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
      'WM_SVC.NAME': 'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
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

async function call(path) {
  const token = await getToken();
  const res = await fetch(`${config.lider.apiUrl}${path}`, {
    headers: {
      Accept: 'application/json',
      'WM_SEC.ACCESS_TOKEN': token,
      'WM_SVC.NAME': 'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
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
  const lines = order.orderLines?.orderLine || order.orderLines || [];

  const activas = (Array.isArray(lines) ? lines : [lines]).filter((l) => {
    const estados = l.orderLineStatuses?.orderLineStatus || [];
    const estado = (Array.isArray(estados) ? estados[0] : estados)?.status || '';
    return !/Cancelled/i.test(estado);
  });

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
    return { canonical: toCanonicalOrder(order), raw: order };
  },

  async listRecentOrderIds(limit = 50) {
    const desde = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const params = new URLSearchParams({ createdStartDate: desde, limit: String(limit) });
    const data = await call(`${ENDPOINTS.orders}?${params}`);
    const ids = unwrapOrders(data).map((o) => String(o.purchaseOrderId || o.customerOrderId));
    log.debug('lider.sweep', { encontradas: ids.length });
    return ids;
  },
};
