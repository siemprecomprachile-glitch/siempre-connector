import { config } from '../config.js';
import { orders, events } from '../db.js';
import { log } from '../logger.js';
import { getChannel } from '../channels/index.js';
import { issueDocument } from '../bsale/documents.js';
import { issueCreditNote } from '../bsale/credit-notes.js';

const MAX_ATTEMPTS = 8;
// Una orden "processing" por mas de 10 minutos se considera colgada.
const STALE_LOCK_MS = 10 * 60 * 1000;

/** Backoff: 1min, 2, 4, 8, 16, 32, 64, 128 minutos. */
function backoffMs(attempt) {
  return Math.min(2 ** (attempt - 1), 128) * 60 * 1000;
}

/**
 * Registra la orden si es nueva. Si ya existe, devuelve el registro.
 * Esta es la barrera anti-duplicados: la UNIQUE(channel, external_id) de SQLite
 * garantiza que dos webhooks simultaneos no emitan dos documentos.
 */
export function registerOrder(channel, externalId) {
  const fresh = orders.claim(channel, externalId);
  return fresh || orders.find(channel, externalId);
}

/**
 * Procesa una orden de punta a punta: la busca en el canal, la traduce y
 * emite el documento en Bsale. Es seguro llamarla dos veces.
 *
 * @param {object} opts
 * @param {object} [opts.canonicalOverride] orden ya canonica (Shopify la manda en el webhook)
 */
export async function processOrder(channelName, externalId, { canonicalOverride } = {}) {
  const record = registerOrder(channelName, externalId);

  // Ya facturada. El aviso puede ser un duplicado (no se hace nada) o la
  // noticia de que la venta se cayo despues (toca nota de credito).
  if (record.status === 'done') {
    const canal = getChannel(channelName);
    if (typeof canal.checkRefund === 'function' && !record.nc_document_id) {
      let info = { refunded: false };
      try {
        info = await canal.checkRefund(externalId);
      } catch (err) {
        log.warn('order.refund_check_failed', { channel: channelName, externalId, msg: err.message });
      }
      orders.update(record.id, { last_refund_check: Date.now() });
      if (info.refunded) return processRefund(channelName, externalId, info);
    }
    log.info('order.already_done', { channel: channelName, externalId });
    return { status: 'done', skipped: true, record };
  }
  if (record.status === 'skipped') {
    return { status: 'skipped', skipped: true, record };
  }

  // Estados de nota de credito: la venta ya tiene su documento y su anulacion
  // en curso o resuelta. Un aviso que llegue ahora NO puede volver a facturar.
  if (['credited', 'credit_retry', 'credit_failed', 'review'].includes(record.status)) {
    log.info('order.already_credited', { channel: channelName, externalId, status: record.status });
    return { status: record.status, skipped: true, record };
  }
  // Otra ejecucion la tiene tomada. Sin esto, dos webhooks del mismo pedido
  // llegando juntos emitirian dos documentos. El candado se libera solo si
  // quedo colgado (proceso caido a mitad de camino).
  if (record.status === 'processing' && Date.now() - record.updated_at < STALE_LOCK_MS) {
    log.info('order.in_flight', { channel: channelName, externalId });
    return { status: 'processing', skipped: true, record };
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    return { status: 'failed', record };
  }

  const attempts = record.attempts + 1;
  orders.update(record.id, { status: 'processing', attempts });

  try {
    let canonical = canonicalOverride;
    let raw = null;

    if (!canonical) {
      const channel = getChannel(channelName);
      const result = await channel.fetchOrder(externalId);
      raw = result.raw;

      if (result.skip) {
        orders.update(record.id, {
          status: 'skipped',
          last_error: result.skip,
          raw_order: JSON.stringify(raw ?? null),
        });
        events.add('info', `Omitida: ${result.skip}`, { channel: channelName, orderRef: externalId });
        return { status: 'skipped', reason: result.skip };
      }

      if (result.retryLater) {
        orders.update(record.id, {
          status: 'retry',
          last_error: result.retryLater,
          next_attempt_at: Date.now() + backoffMs(attempts),
        });
        return { status: 'retry', reason: result.retryLater };
      }

      canonical = result.canonical;
    }

    // Margen para cancelaciones: no facturamos antes de tiempo.
    if (config.rules.billingDelayMinutes > 0) {
      const readyAt = canonical.createdAt.getTime() + config.rules.billingDelayMinutes * 60000;
      if (Date.now() < readyAt) {
        orders.update(record.id, {
          status: 'retry',
          last_error: `en espera (${config.rules.billingDelayMinutes} min de margen)`,
          next_attempt_at: readyAt,
        });
        return { status: 'retry', reason: 'delay' };
      }
    }

    orders.update(record.id, {
      customer_name: canonical.customer.name,
      customer_rut: canonical.customer.rut,
      total: canonical.total,
      raw_order: JSON.stringify(raw ?? canonical),
    });

    const issued = await issueDocument(canonical);

    orders.update(record.id, {
      status: 'done',
      doc_kind: issued.docKind,
      bsale_document_id: issued.documentId,
      bsale_number: issued.number,
      bsale_url: issued.url,
      bsale_payload: JSON.stringify(issued.payload),
      last_error: null,
      next_attempt_at: null,
    });

    events.add('info', `${issued.docKind} ${issued.number ?? ''} emitida`, {
      channel: channelName,
      orderRef: externalId,
      detail: { documentId: issued.documentId, total: canonical.total },
    });

    // Algunos marketplaces (Paris) exigen que el documento se les suba: es lo
    // que dispara el envio al comprador. Si falla, el documento YA esta emitido
    // y valido — se avisa, no se pierde ni se reintenta la emision.
    await subirDocumentoAlCanal(channelName, externalId, issued);
    log.info('order.done', {
      channel: channelName,
      externalId,
      docKind: issued.docKind,
      number: issued.number,
    });

    return { status: 'done', document: issued };
  } catch (err) {
    const permanent = Boolean(err.permanent) || attempts >= MAX_ATTEMPTS;
    orders.update(record.id, {
      status: permanent ? 'failed' : 'retry',
      last_error: err.message,
      next_attempt_at: permanent ? null : Date.now() + backoffMs(attempts),
    });
    events.add(permanent ? 'error' : 'warn', err.message, {
      channel: channelName,
      orderRef: externalId,
      detail: { attempts, permanent },
    });
    log.error('order.failed', {
      channel: channelName,
      externalId,
      attempts,
      permanent,
      msg: err.message,
    });
    return { status: permanent ? 'failed' : 'retry', error: err.message };
  }
}

/**
 * Sube el documento emitido al marketplace, cuando ese canal lo pide.
 * Nunca hace fallar la emision: el documento ya existe en Bsale y en el SII.
 */
async function subirDocumentoAlCanal(channelName, externalId, issued) {
  const canal = getChannel(channelName);
  if (typeof canal.uploadInvoice !== 'function') return;

  try {
    await canal.uploadInvoice({
      externalId,
      docKind: issued.docKind,
      number: issued.number,
      pdfUrl: issued.url,
    });
  } catch (err) {
    events.add('warn', `Documento emitido, pero no se pudo subir al canal: ${err.message}`, {
      channel: channelName,
      orderRef: externalId,
    });
    log.warn('order.upload_invoice_failed', {
      channel: channelName,
      externalId,
      msg: err.message,
    });
  }
}

/**
 * Emite la nota de credito de una venta que ya estaba facturada y se cayo.
 *
 * El documento original NO se toca: en Chile un documento tributario emitido
 * no se borra. Queda la boleta y ademas la nota de credito que la anula.
 */
export async function processRefund(channelName, externalId, info = {}) {
  const record = orders.find(channelName, externalId);

  if (!record) {
    return { status: 'ignored', reason: 'esa venta nunca paso por aca' };
  }
  if (!record.bsale_document_id) {
    // Nunca se facturo: no hay nada que anular, basta con marcarla.
    if (record.status !== 'skipped') {
      orders.update(record.id, {
        status: 'skipped',
        last_error: info.motive || 'Venta cancelada antes de facturar',
      });
    }
    return { status: 'ignored', reason: 'no alcanzo a emitirse documento' };
  }
  if (record.nc_document_id) {
    return { status: 'credited', skipped: true, record };
  }

  const motive = info.motive || record.nc_motive || 'Devolucion';

  // Devolucion parcial: no se adivina que linea se devolvio.
  if (info.partial) {
    orders.update(record.id, {
      status: 'review',
      nc_motive: motive,
      last_error:
        `Devolucion parcial de ${Math.round(info.amount || 0).toLocaleString('es-CL')} sobre ` +
        `${record.doc_kind || 'documento'} N° ${record.bsale_number}. ` +
        `Emite la nota de credito a mano indicando que producto se devolvio.`,
    });
    events.add('warn', 'Devolucion parcial: necesita tu decision', {
      channel: channelName,
      orderRef: externalId,
      detail: { amount: info.amount },
    });
    return { status: 'review', reason: 'parcial' };
  }

  const attempts = (record.attempts || 0) + 1;

  try {
    const nc = await issueCreditNote({ documentId: record.bsale_document_id, motive });

    orders.update(record.id, {
      status: 'credited',
      nc_document_id: nc.creditNoteId,
      nc_number: nc.number,
      nc_url: nc.url,
      nc_motive: motive,
      credited_at: Date.now(),
      last_error: null,
      next_attempt_at: null,
    });

    events.add('info', `Nota de credito ${nc.number ?? ''} emitida — ${motive}`, {
      channel: channelName,
      orderRef: externalId,
      detail: { anula: record.bsale_number },
    });
    log.info('order.credited', { channel: channelName, externalId, number: nc.number });

    return { status: 'credited', creditNote: nc };
  } catch (err) {
    const permanent = Boolean(err.permanent) || attempts >= MAX_ATTEMPTS;
    orders.update(record.id, {
      status: permanent ? 'credit_failed' : 'credit_retry',
      nc_motive: motive,
      attempts,
      last_error: err.message,
      next_attempt_at: permanent ? null : Date.now() + backoffMs(attempts),
    });
    events.add(permanent ? 'error' : 'warn', `Nota de credito: ${err.message}`, {
      channel: channelName,
      orderRef: externalId,
    });
    log.error('order.credit_failed', { channel: channelName, externalId, msg: err.message, permanent });
    return { status: permanent ? 'credit_failed' : 'credit_retry', error: err.message };
  }
}

/** Vuelve a intentar una orden marcada como fallida (desde el panel). */
export async function retryOrder(id) {
  const record = orders.get(id);
  if (!record) throw new Error('Orden no encontrada');

  // Si lo que fallo fue la nota de credito, se reintenta esa, no la venta.
  if (record.status === 'credit_failed' || record.status === 'credit_retry') {
    orders.update(id, { attempts: 0, next_attempt_at: null, last_error: null });
    return processRefund(record.channel, record.external_id, { motive: record.nc_motive });
  }

  orders.update(id, { status: 'pending', attempts: 0, next_attempt_at: null, last_error: null });
  return processOrder(record.channel, record.external_id);
}

export { MAX_ATTEMPTS };
