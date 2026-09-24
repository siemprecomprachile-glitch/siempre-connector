import crypto from 'node:crypto';
import { config } from '../../config.js';
import { buildOrder } from '../../core/canonical.js';
import { formatRut } from '../../core/rut.js';

/**
 * Falabella Seller Center no envia webhooks: hay que consultar sus ordenes.
 * Cada request va firmado con HMAC-SHA256 sobre los parametros ordenados.
 * Doc: https://developers.falabella.com/docs/getting-started
 */
function sign(params) {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  const signature = crypto
    .createHmac('sha256', config.falabella.apiKey)
    .update(sorted)
    .digest('hex');
  return `${sorted}&Signature=${signature}`;
}

async function call(action, extra = {}) {
  const query = sign({
    Action: action,
    Format: 'JSON',
    Timestamp: new Date().toISOString(),
    UserID: config.falabella.userId,
    Version: '1.0',
    ...extra,
  });

  const res = await fetch(`${config.falabella.apiUrl}/?${query}`, {
    headers: { Accept: 'application/json' },
  });
  const data = await res.json().catch(() => null);

  if (!res.ok || data?.ErrorResponse) {
    const msg = data?.ErrorResponse?.Head?.ErrorMessage || res.statusText;
    const err = new Error(`Falabella ${res.status}: ${msg}`);
    err.permanent = res.status >= 400 && res.status < 500;
    throw err;
  }
  return data?.SuccessResponse?.Body ?? data;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function toCanonicalOrder({ order, items }) {
  const lines = asArray(items?.OrderItem).map((it) => ({
    sku: it.SellerSku || it.Sku || null,
    name: it.Name || 'Producto',
    quantity: 1, // Falabella entrega un OrderItem por unidad vendida.
    unitPrice: Number(it.ItemPrice) || 0,
    discount: 0,
  }));

  const shippingCost = asArray(items?.OrderItem).reduce(
    (acc, it) => acc + (Number(it.ShippingAmount) || 0),
    0
  );

  return buildOrder({
    channel: 'falabella',
    externalId: order.OrderId,
    reference: `Falabella #${order.OrderNumber || order.OrderId}`,
    createdAt: order.CreatedAt,
    paid: true, // Falabella entrega la orden ya pagada.
    currency: 'CLP',
    total: lines.reduce((acc, l) => acc + l.unitPrice * l.quantity, 0) + shippingCost,
    shippingCost,
    customer: {
      rut: formatRut(order.NationalRegistrationNumber),
      name: [order.CustomerFirstName, order.CustomerLastName].filter(Boolean).join(' ') || 'Consumidor Final',
      businessName: null,
      activity: null,
      email: null,
      phone: order.AddressBilling?.Phone || null,
      address: order.AddressBilling?.Address1 || null,
      city: order.AddressBilling?.City || null,
      municipality: order.AddressBilling?.City || null,
    },
    items: lines,
  });
}

export const falabellaChannel = {
  name: 'falabella',
  label: 'Falabella',
  get enabled() {
    return config.falabella.enabled;
  },

  async fetchOrder(orderId) {
    const [orderRes, itemsRes] = await Promise.all([
      call('GetOrder', { OrderId: orderId }),
      call('GetOrderItems', { OrderId: orderId }),
    ]);
    const order = orderRes?.Orders?.Order || orderRes?.Order;
    return {
      canonical: toCanonicalOrder({ order, items: itemsRes?.OrderItems }),
      raw: { order, items: itemsRes },
    };
  },

  /** Ordenes listas para facturar desde una fecha. */
  async listRecentOrderIds({ since } = {}) {
    const createdAfter = (since || new Date(Date.now() - 24 * 3600 * 1000)).toISOString();
    const res = await call('GetOrders', { CreatedAfter: createdAfter, Status: 'ready_to_ship' });
    return asArray(res?.Orders?.Order).map((o) => String(o.OrderId));
  },
};
