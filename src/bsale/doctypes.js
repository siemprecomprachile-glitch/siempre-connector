import { config } from '../config.js';
import { log } from '../logger.js';
import { bsale } from './client.js';

// Codigos SII estandar: 39 boleta electronica, 33 factura electronica, 61 nota de credito.
const SII = { boleta: 39, factura: 33, notaCredito: 61 };

let lastTry = 0;

function pending() {
  return !config.bsale.boletaTypeId || !config.bsale.facturaTypeId || !config.bsale.notaCreditoTypeId;
}

/** IDs activos (los del .env, o los deducidos solos). */
export function docTypeSummary() {
  return {
    boletaTypeId: config.bsale.boletaTypeId || null,
    facturaTypeId: config.bsale.facturaTypeId || null,
    notaCreditoTypeId: config.bsale.notaCreditoTypeId || null,
    complete: !pending(),
  };
}

/**
 * Si faltan BSALE_DOCTYPE_* en el .env, los deduce solos: consulta los tipos de
 * documento de la cuenta Bsale y toma el que tenga el codigo SII que corresponde.
 * Un ID puesto a mano en el .env siempre manda sobre el deducido.
 * Nunca lanza: si Bsale falla, los IDs quedan como estaban y se reintenta despues.
 */
export async function resolveDocTypeIds({ force = false } = {}) {
  if (!force && !pending()) return docTypeSummary();
  if (!config.bsale.token) return docTypeSummary();
  // No martillar a Bsale si acaba de fallar.
  if (!force && Date.now() - lastTry < 60_000) return docTypeSummary();
  lastTry = Date.now();
  try {
    const res = await bsale.documentTypes();
    const items = res?.items || [];
    const byCode = (code) => Number(items.find((d) => Number(d.codeSii) === code)?.id) || 0;
    if (!config.bsale.boletaTypeId) config.bsale.boletaTypeId = byCode(SII.boleta);
    if (!config.bsale.facturaTypeId) config.bsale.facturaTypeId = byCode(SII.factura);
    if (!config.bsale.notaCreditoTypeId) config.bsale.notaCreditoTypeId = byCode(SII.notaCredito);
    log.info('bsale.doctypes_resolved', docTypeSummary());
  } catch (err) {
    log.warn('bsale.doctypes_resolve_failed', { msg: err.message });
  }
  return docTypeSummary();
}
