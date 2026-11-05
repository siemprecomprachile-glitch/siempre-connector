import { getChannel } from '../channels/index.js';
import { orders } from '../db.js';
import { buildDocumentPayload, salesIdFor } from '../bsale/documents.js';
import { channelStartAt } from '../config.js';

/**
 * Diagnostico de solo lectura. Nada de este archivo llama a processOrder ni a
 * POST /documents.json: no registra ventas ni emite documentos. Funciona aunque
 * el canal este apagado (PARIS_ENABLED / LIDER_ENABLED = false), que es como
 * hay que probarlo: con el canal encendido el barrido empezaria a facturar.
 */

/** Prueba credenciales y lectura: pide los pedidos recientes y los cuenta. */
export async function probeChannel(name, { limit = 10 } = {}) {
  const channel = getChannel(name);
  const started = Date.now();
  const out = { channel: name, enabled: Boolean(channel.enabled), readOnly: true };

  if (typeof channel.listRecentOrderIds !== 'function') {
    return { ...out, ok: false, error: 'Este canal no permite listar pedidos.' };
  }

  try {
    const ids = await channel.listRecentOrderIds(limit);
    const res = {
      ...out,
      ok: true,
      found: ids.length,
      sampleIds: ids.slice(0, limit),
      alreadyRegistered: ids.filter((id) => orders.find(name, id)).length,
      ms: Date.now() - started,
    };
    // Lider: cuantas hay sin confirmar o canceladas (no aparecen en `found`).
    if (typeof channel.recentOrderSummary === 'function') {
      res.summary = await channel.recentOrderSummary(limit);
    }
    return res;
  } catch (err) {
    return { ...out, ok: false, error: err.message, status: err.status ?? null, ms: Date.now() - started };
  }
}

/**
 * Lee un pedido y muestra el documento que se emitiria, sin emitirlo.
 * Solo hace lecturas en Bsale (tipos de documento y variantes por SKU).
 */
export async function previewOrder(name, externalId) {
  const channel = getChannel(name);
  const out = {
    channel: name,
    externalId: String(externalId),
    readOnly: true,
    sentToBsale: false,
  };

  const result = await channel.fetchOrder(externalId);
  if (result.skip) return { ...out, skip: result.skip };
  if (result.retryLater) return { ...out, retryLater: result.retryLater };

  const order = result.canonical;
  const record = orders.find(name, externalId);
  const { docKind, payload } = await buildDocumentPayload(order, {
    docKind: record?.emit_doc_kind || undefined,
    salesId: salesIdFor(name, externalId),
  });
  const startAt = channelStartAt(name);

  return {
    ...out,
    registeredStatus: record ? record.status : null,
    existingDocument: record?.bsale_document_id
      ? { id: record.bsale_document_id, number: record.bsale_number, kind: record.doc_kind, url: record.bsale_url }
      : null,
    startAt: startAt ? startAt.toISOString() : null,
    beforeStart: Boolean(startAt && order.createdAt < startAt),
    order: {
      reference: order.reference,
      createdAt: order.createdAt,
      paid: order.paid,
      total: order.total,
      shippingCost: order.shippingCost,
      docHint: order.docHint,
      customer: order.customer,
      items: order.items,
    },
    docKind,
    payload,
  };
}
