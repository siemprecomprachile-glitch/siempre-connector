import { buildOrder } from '../../core/canonical.js';
import { formatRut } from '../../core/rut.js';

/**
 * Lee el bloque de facturacion de ML sin asumir un unico formato.
 * ML devuelve a veces campos planos (doc_type/doc_number) y a veces una lista
 * `additional_info` con pares type/value.
 */
export function parseBillingInfo(billing) {
  const info = billing?.buyer?.billing_info || billing?.billing_info || billing || {};
  const out = {};

  const additional = info.additional_info || [];
  for (const entry of additional) {
    const key = String(entry.type || entry.key || '').toUpperCase();
    const value = entry.value;
    if (value == null || value === '') continue;
    out[key] = String(value);
  }

  // Formato plano / identification.
  if (info.doc_number) out.DOC_NUMBER ||= String(info.doc_number);
  if (info.doc_type) out.DOC_TYPE ||= String(info.doc_type);
  if (info.identification?.number) out.DOC_NUMBER ||= String(info.identification.number);
  if (info.identification?.type) out.DOC_TYPE ||= String(info.identification.type);
  if (info.name) out.FIRST_NAME ||= String(info.name);
  if (info.last_name) out.LAST_NAME ||= String(info.last_name);

  const address = info.address || {};
  if (address.street_name) out.STREET_NAME ||= String(address.street_name);
  if (address.street_number) out.STREET_NUMBER ||= String(address.street_number);
  if (address.city_name) out.CITY_NAME ||= String(address.city_name);
  if (address.state_name) out.STATE_NAME ||= String(address.state_name);

  const rutRaw = out.DOC_NUMBER || null;
  const rut = formatRut(rutRaw);

  const streetParts = [out.STREET_NAME, out.STREET_NUMBER].filter(Boolean).join(' ');

  return {
    rut,
    rutRaw,
    docType: out.DOC_TYPE || null,
    businessName: out.BUSINESS_NAME || out.LEGAL_NAME || null,
    activity: out.ACTIVITY || out.GIRO || out.TAXPAYER_TYPE_ACTIVITY || null,
    firstName: out.FIRST_NAME || null,
    lastName: out.LAST_NAME || null,
    address: streetParts || null,
    city: out.CITY_NAME || null,
    municipality: out.CITY_NAME || null,
    state: out.STATE_NAME || null,
  };
}

/** Suma lo que el comprador pago de despacho. */
export function shippingCostOf(order, shipment) {
  const fromPayments = (order.payments || []).reduce(
    (acc, p) => acc + (Number(p.shipping_cost) || 0),
    0
  );
  if (fromPayments > 0) return fromPayments;
  const fromShipment = Number(shipment?.shipping_option?.cost) || 0;
  return fromShipment;
}

export function isPaid(order) {
  if (order.status === 'paid') return true;
  return (order.payments || []).some((p) => p.status === 'approved');
}

export function isCancelled(order) {
  return order.status === 'cancelled' || order.status === 'invalid';
}

const ESTADOS_DEVUELTOS = ['refunded', 'charged_back', 'cancelled', 'rejected'];

/**
 * Mira si una venta que YA facturamos se cayo despues: el comprador cancelo,
 * pidio devolucion o hizo un contracargo. En Chile eso no se corrige borrando
 * la boleta, se corrige con una nota de credito.
 */
export function refundInfo(order) {
  const pagos = order.payments || [];
  const aprobados = pagos.filter((p) => p.status === 'approved');
  const devueltos = pagos.filter((p) => ESTADOS_DEVUELTOS.includes(p.status));

  const montoDevuelto = devueltos.reduce(
    (acc, p) =>
      acc + (Number(p.transaction_amount_refunded) || Number(p.total_paid_amount) || 0),
    0
  );

  if (isCancelled(order)) {
    const detalle = order.status_detail ? ` (${order.status_detail})` : '';
    return { refunded: true, motive: `Orden cancelada en Mercado Libre${detalle}`, amount: montoDevuelto };
  }

  if (devueltos.length && !aprobados.length) {
    return { refunded: true, motive: 'Pago reembolsado en Mercado Libre', amount: montoDevuelto };
  }

  // Quedo un pago aprobado y ademas hay plata devuelta: es parcial. No se
  // adivina que linea se devolvio — eso lo decide una persona.
  if (devueltos.length && aprobados.length && montoDevuelto > 0) {
    return {
      refunded: true,
      partial: true,
      amount: montoDevuelto,
      motive: 'Reembolso parcial en Mercado Libre',
    };
  }

  return { refunded: false };
}

/** Traduce una orden de Mercado Libre a la orden canonica. */
export function toCanonicalOrder({ order, billing, shipment }) {
  const b = parseBillingInfo(billing);
  const receiver = shipment?.receiver_address || {};

  const buyerName =
    [b.firstName, b.lastName].filter(Boolean).join(' ').trim() ||
    [order.buyer?.first_name, order.buyer?.last_name].filter(Boolean).join(' ').trim() ||
    order.buyer?.nickname ||
    'Consumidor Final';

  const address =
    b.address ||
    [receiver.street_name, receiver.street_number].filter(Boolean).join(' ') ||
    null;

  const items = (order.order_items || []).map((oi) => ({
    sku: oi.item?.seller_sku || oi.item?.seller_custom_field || oi.item?.id || null,
    name: oi.item?.title || 'Producto',
    quantity: Number(oi.quantity) || 1,
    // full_unit_price es el precio de lista; unit_price es lo efectivamente
    // cobrado al comprador (ya con descuentos del vendedor aplicados).
    unitPrice: Number(oi.unit_price) || 0,
    discount: 0,
  }));

  const shippingCost = shippingCostOf(order, shipment);
  // El total lo manda Mercado Libre (total_amount = suma de items, sin despacho).
  // No se recalcula desde los items a proposito: asi la validacion de la orden
  // canonica detecta cualquier diferencia entre lo que ML cobro y lo que
  // estamos por facturar, en vez de arrastrar el error al SII.
  const declaredTotal = Number(order.total_amount);
  const itemsTotal = Number.isFinite(declaredTotal)
    ? declaredTotal
    : items.reduce((acc, i) => acc + i.unitPrice * i.quantity, 0);

  return buildOrder({
    channel: 'mercadolibre',
    externalId: order.id,
    reference: `Mercado Libre #${order.id}`,
    createdAt: order.date_closed || order.date_created,
    paid: isPaid(order),
    currency: order.currency_id || 'CLP',
    total: itemsTotal + shippingCost,
    shippingCost,
    customer: {
      rut: b.rut,
      name: buyerName,
      businessName: b.businessName,
      activity: b.activity,
      email: order.buyer?.email || null,
      phone: order.buyer?.phone?.number || receiver.receiver_phone || null,
      address,
      city: b.city || receiver.city?.name || null,
      municipality: b.municipality || receiver.city?.name || null,
    },
    items,
  });
}
