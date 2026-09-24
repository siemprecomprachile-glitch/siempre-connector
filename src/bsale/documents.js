import { config } from '../config.js';
import { bsale } from './client.js';
import { formatRut, looksLikeCompany } from '../core/rut.js';

const IVA = 0.19;

/**
 * Decide boleta o factura.
 * Regla: hay factura solo si el comprador entrego RUT valido Y razon social.
 * Sin razon social el SII no acepta la factura, asi que cae a boleta.
 */
export function decideDocKind(order) {
  // Si el canal ya sabe lo que el comprador pidio, se le hace caso.
  if (order.docHint) return order.docHint;
  if (!config.rules.autoFacturaOnRut) return 'boleta';
  const rut = formatRut(order.customer.rut);
  if (!rut) return 'boleta';
  const hasCompanyData = Boolean(order.customer.businessName);
  if (hasCompanyData || looksLikeCompany(rut)) return 'factura';
  return 'boleta';
}

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: 'Consumidor', lastName: 'Final' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '.' };
  const half = Math.ceil(parts.length / 2);
  return { firstName: parts.slice(0, half).join(' '), lastName: parts.slice(half).join(' ') };
}

/** Valor neto a partir del bruto (el precio que cobra el marketplace incluye IVA). */
export function netFromGross(gross) {
  return Number((gross / (1 + IVA)).toFixed(4));
}

function buildClient(order, docKind) {
  const rut = formatRut(order.customer.rut);
  const { firstName, lastName } = splitName(order.customer.name);

  if (docKind === 'factura') {
    // El SII exige RUT, razon social, giro y direccion en la factura.
    const missing = [];
    if (!rut) missing.push('RUT');
    if (!order.customer.businessName) missing.push('razon social');
    if (!order.customer.activity) missing.push('giro');
    if (!order.customer.address) missing.push('direccion');
    if (missing.length) {
      const err = new Error(
        `No se puede emitir factura: falta ${missing.join(', ')}. ` +
          `Completa los datos en el canal o emite boleta.`
      );
      err.permanent = true;
      err.code = 'MISSING_INVOICE_DATA';
      throw err;
    }
    return {
      code: rut,
      company: order.customer.businessName,
      activity: order.customer.activity,
      address: order.customer.address,
      municipality: order.customer.municipality || order.customer.city || '',
      city: order.customer.city || order.customer.municipality || '',
      email: order.customer.email || '',
      phone: order.customer.phone || '',
    };
  }

  // Boleta: el cliente es opcional, pero guardarlo sirve para el historial.
  const client = { firstName, lastName };
  if (rut) client.code = rut;
  if (order.customer.email) client.email = order.customer.email;
  if (order.customer.phone) client.phone = order.customer.phone;
  if (order.customer.address) client.address = order.customer.address;
  if (order.customer.municipality) client.municipality = order.customer.municipality;
  if (order.customer.city) client.city = order.customer.city;
  return client;
}

async function buildDetails(order) {
  const details = [];

  for (const item of order.items) {
    // Si el SKU existe en Bsale usamos la variante: descuenta stock y deja
    // el documento ligado al producto real del inventario.
    const variant = await bsale.findVariantByCode(item.sku);

    const detail = {
      quantity: item.quantity,
      netUnitValue: netFromGross(item.unitPrice),
      taxId: `[${config.bsale.taxId}]`,
    };
    if (item.discount) detail.discount = Number(item.discount);

    if (variant) {
      detail.variantId = variant.id;
      detail.comment = item.name;
    } else {
      // Sin variante, Bsale emite una linea libre (no toca inventario).
      detail.comment = item.sku ? `${item.name} (${item.sku})` : item.name;
    }

    details.push(detail);
  }

  if (order.shippingCost > 0) {
    details.push({
      quantity: 1,
      netUnitValue: netFromGross(order.shippingCost),
      taxId: `[${config.bsale.taxId}]`,
      comment: 'Despacho',
    });
  }

  return details;
}

/** Arma el payload exacto que se envia a POST /v1/documents.json. */
export async function buildDocumentPayload(order) {
  const docKind = decideDocKind(order);
  const documentTypeId =
    docKind === 'factura' ? config.bsale.facturaTypeId : config.bsale.boletaTypeId;

  if (!documentTypeId) {
    const err = new Error(
      `Falta configurar BSALE_DOCTYPE_${docKind.toUpperCase()}_ID en el .env`
    );
    err.permanent = true;
    throw err;
  }

  const emission = Math.floor(order.createdAt.getTime() / 1000);
  const payload = {
    documentTypeId,
    officeId: config.bsale.officeId,
    emissionDate: emission,
    expirationDate: emission,
    declareSii: config.bsale.declareSii,
    client: buildClient(order, docKind),
    details: await buildDetails(order),
  };

  if (config.bsale.paymentTypeId) {
    payload.payments = [
      {
        recordDate: emission,
        amount: order.total,
        paymentTypeId: config.bsale.paymentTypeId,
      },
    ];
  }

  // Queda escrito en el documento de donde vino la venta.
  payload.dynamicAttributes = [{ description: 'Origen', value: order.reference }];

  return { docKind, payload };
}

/** Emite el documento en Bsale y devuelve los datos utiles. */
export async function issueDocument(order) {
  const { docKind, payload } = await buildDocumentPayload(order);
  const doc = await bsale.createDocument(payload);

  return {
    docKind,
    payload,
    documentId: doc?.id ?? null,
    number: doc?.number != null ? String(doc.number) : null,
    url: doc?.urlPublicView || doc?.urlPdf || null,
    raw: doc,
  };
}
