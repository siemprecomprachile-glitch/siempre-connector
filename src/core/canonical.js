/**
 * Orden canonica: el formato unico al que cada canal traduce sus ordenes.
 * Todo lo que viene despues (reglas de negocio, Bsale) solo conoce esta forma.
 *
 * {
 *   channel:      'mercadolibre' | 'shopify' | 'falabella',
 *   externalId:   '2000012345678',
 *   reference:    '#ML-2000012345678',   // lo que se ve en el documento
 *   createdAt:    Date,
 *   paid:         true,
 *   currency:     'CLP',
 *   total:        119000,                // BRUTO, con IVA incluido
 *   shippingCost: 3990,                  // BRUTO
 *   customer: {
 *     rut:        '12345678-9' | null,
 *     name:       'Juan Perez',
 *     businessName: 'Barberia Spa' | null,
 *     activity:   'Peluqueria' | null,   // giro, requerido en factura
 *     email, phone, address, city, municipality
 *   },
 *   items: [{ sku, name, quantity, unitPrice /* BRUTO *\/, discount }]
 * }
 */

export function buildOrder(partial) {
  const order = {
    channel: partial.channel,
    externalId: String(partial.externalId),
    reference: partial.reference || String(partial.externalId),
    createdAt: partial.createdAt ? new Date(partial.createdAt) : new Date(),
    paid: Boolean(partial.paid),
    currency: partial.currency || 'CLP',
    total: round(partial.total || 0),
    shippingCost: round(partial.shippingCost || 0),
    // Algunos canales (Paris) ya saben si el comprador pidio boleta o factura.
    // Cuando viene, manda sobre la deduccion por RUT.
    docHint: partial.docHint === 'factura' || partial.docHint === 'boleta' ? partial.docHint : null,
    customer: {
      rut: partial.customer?.rut || null,
      name: partial.customer?.name || 'Consumidor Final',
      businessName: partial.customer?.businessName || null,
      activity: partial.customer?.activity || null,
      email: partial.customer?.email || null,
      phone: partial.customer?.phone || null,
      address: partial.customer?.address || null,
      city: partial.customer?.city || null,
      municipality: partial.customer?.municipality || null,
    },
    items: (partial.items || []).map((i) => ({
      sku: i.sku || null,
      name: (i.name || 'Producto').slice(0, 100),
      quantity: Number(i.quantity) || 1,
      unitPrice: round(i.unitPrice || 0),
      discount: Number(i.discount) || 0,
    })),
  };

  validate(order);
  return order;
}

function round(n) {
  // CLP no usa decimales.
  return Math.round(Number(n) || 0);
}

function validate(order) {
  const errors = [];
  if (!order.channel) errors.push('falta channel');
  if (!order.externalId) errors.push('falta externalId');
  if (!order.items.length) errors.push('la orden no tiene items');
  for (const item of order.items) {
    if (item.quantity <= 0) errors.push(`cantidad invalida en "${item.name}"`);
    if (item.unitPrice < 0) errors.push(`precio invalido en "${item.name}"`);
  }
  if (order.total <= 0) errors.push('total en 0');

  const computed =
    order.items.reduce((acc, i) => acc + i.unitPrice * i.quantity - i.discount, 0) +
    order.shippingCost;
  // Tolerancia de 2 pesos por redondeos del canal.
  if (Math.abs(computed - order.total) > 2) {
    errors.push(
      `el total no cuadra: items+envio = ${computed} pero el canal informa ${order.total}`
    );
  }

  if (errors.length) {
    const err = new Error(`Orden invalida: ${errors.join('; ')}`);
    err.code = 'INVALID_ORDER';
    err.permanent = true;
    throw err;
  }
}
