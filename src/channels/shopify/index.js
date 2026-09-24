import crypto from 'node:crypto';
import { config } from '../../config.js';
import { buildOrder } from '../../core/canonical.js';
import { formatRut } from '../../core/rut.js';

/** Verifica la firma HMAC del webhook de Shopify. */
export function verifyWebhook(rawBody, hmacHeader) {
  if (!config.shopify.webhookSecret) return false;
  const digest = crypto
    .createHmac('sha256', config.shopify.webhookSecret)
    .update(rawBody, 'utf8')
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader || ''));
  } catch {
    return false;
  }
}

/**
 * Busca el RUT donde suelen guardarlo las tiendas chilenas:
 * note_attributes del checkout, campos custom del cliente, o la nota.
 */
function findRut(payload) {
  const candidates = [];
  for (const attr of payload.note_attributes || []) {
    if (/rut|dni|documento/i.test(attr.name || '')) candidates.push(attr.value);
  }
  for (const attr of payload.attributes || []) {
    if (/rut/i.test(attr.name || '')) candidates.push(attr.value);
  }
  if (payload.note) {
    const match = String(payload.note).match(/\b\d{7,8}\s*-?\s*[\dkK]\b/);
    if (match) candidates.push(match[0]);
  }
  if (payload.billing_address?.company) candidates.push(payload.billing_address.company);

  for (const c of candidates) {
    const rut = formatRut(c);
    if (rut) return rut;
  }
  return null;
}

function findAttr(payload, regex) {
  for (const attr of [...(payload.note_attributes || []), ...(payload.attributes || [])]) {
    if (regex.test(attr.name || '')) return attr.value || null;
  }
  return null;
}

export function toCanonicalOrder(payload) {
  const addr = payload.billing_address || payload.shipping_address || {};
  const shippingCost = (payload.shipping_lines || []).reduce(
    (acc, l) => acc + Number(l.price || 0),
    0
  );

  const items = (payload.line_items || []).map((li) => ({
    sku: li.sku || String(li.variant_id || ''),
    name: li.title + (li.variant_title && li.variant_title !== 'Default Title' ? ` - ${li.variant_title}` : ''),
    quantity: Number(li.quantity) || 1,
    unitPrice: Number(li.price) || 0,
    discount: Number(li.total_discount) || 0,
  }));

  return buildOrder({
    channel: 'shopify',
    externalId: payload.id,
    reference: `Shopify ${payload.name || payload.order_number || payload.id}`,
    createdAt: payload.processed_at || payload.created_at,
    paid: payload.financial_status === 'paid',
    currency: payload.currency || 'CLP',
    total: Number(payload.total_price) || 0,
    shippingCost,
    customer: {
      rut: findRut(payload),
      name:
        [payload.customer?.first_name, payload.customer?.last_name].filter(Boolean).join(' ') ||
        [addr.first_name, addr.last_name].filter(Boolean).join(' ') ||
        'Consumidor Final',
      businessName: findAttr(payload, /razon|razón|empresa|company/i) || addr.company || null,
      activity: findAttr(payload, /giro|actividad/i),
      email: payload.email || payload.customer?.email || null,
      phone: payload.phone || addr.phone || null,
      address: [addr.address1, addr.address2].filter(Boolean).join(' ') || null,
      city: addr.city || null,
      municipality: addr.city || null,
    },
    items,
  });
}

export const shopifyChannel = {
  name: 'shopify',
  label: 'Shopify',
  get enabled() {
    return config.shopify.enabled;
  },
  verifyWebhook,
  toCanonicalOrder,

  // El webhook de Shopify ya trae la orden completa, no hay que ir a buscarla.
  async fetchOrder() {
    const err = new Error(
      'Shopify entrega la orden dentro del webhook; no se consulta por id en esta version.'
    );
    err.permanent = true;
    throw err;
  },
};
