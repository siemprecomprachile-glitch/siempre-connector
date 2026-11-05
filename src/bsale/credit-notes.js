import { config } from '../config.js';
import { resolveDocTypeIds } from './doctypes.js';
import { bsale } from './client.js';
import { log } from '../logger.js';

/**
 * Notas de credito.
 *
 * En Chile un documento tributario emitido no se borra ni se edita: se anula
 * con una nota de credito que lo referencia. Si el comprador se arrepiente
 * manana, la boleta de hoy sigue existiendo y ademas se emite la NC.
 *
 * Bsale lo hace con POST /v1/returns.json, que crea la devolucion y su nota
 * de credito de una sola vez.
 */

/** Devuelve las lineas del documento original con sus ids. */
async function detallesOriginales(documentId) {
  const res = await bsale.documentDetails(documentId);
  const items = res?.items || [];
  if (!items.length) {
    const err = new Error(
      `El documento ${documentId} no tiene detalles en Bsale; no se puede referenciar la devolucion.`
    );
    err.permanent = true;
    throw err;
  }
  return items;
}

/**
 * Arma el payload de la devolucion.
 *
 * @param {object} opts
 * @param {number} opts.documentId   documento original en Bsale
 * @param {string} opts.motive       por que se devuelve (queda impreso en la NC)
 * @param {Array}  [opts.parcial]    [{ sku, quantity }] para devolver solo algunas
 *                                   lineas. Sin esto se devuelve la venta completa.
 */
export async function buildReturnPayload({ documentId, motive, parcial }) {
  await resolveDocTypeIds();
  if (!config.bsale.notaCreditoTypeId) {
    const err = new Error('Falta configurar BSALE_DOCTYPE_NOTA_CREDITO_ID en el .env');
    err.permanent = true;
    throw err;
  }

  const originales = await detallesOriginales(documentId);

  let details;
  if (parcial && parcial.length) {
    details = [];
    for (const pedido of parcial) {
      const linea = originales.find(
        (d) =>
          (pedido.sku && d.variant?.code === pedido.sku) ||
          (pedido.comment && d.comment === pedido.comment)
      );
      if (!linea) {
        const err = new Error(
          `La devolucion menciona "${pedido.sku || pedido.comment}" pero esa linea no esta en el documento original.`
        );
        err.permanent = true;
        throw err;
      }
      const cantidad = Math.min(Number(pedido.quantity) || 1, Number(linea.quantity) || 1);
      details.push({ documentDetailId: linea.id, quantity: cantidad, unitValue: 0 });
    }
  } else {
    // Devolucion total: se devuelve cada linea completa, despacho incluido.
    details = originales.map((d) => ({
      documentDetailId: d.id,
      quantity: Number(d.quantity) || 1,
      unitValue: 0,
    }));
  }

  const ahora = Math.floor(Date.now() / 1000);

  return {
    documentTypeId: config.bsale.notaCreditoTypeId,
    referenceDocumentId: documentId,
    officeId: config.bsale.officeId,
    emissionDate: ahora,
    expirationDate: ahora,
    motive: String(motive || 'Devolucion').slice(0, 100),
    // 0 = se le devuelve el dinero al comprador. Es lo que pasa cuando el
    // marketplace reembolsa: la plata sale, no queda como saldo a favor.
    type: 0,
    priceAdjustment: 0,
    editTexts: 0,
    declareSii: config.bsale.declareSii,
    details,
  };
}

/**
 * Emite la nota de credito y devuelve sus datos.
 *
 * Bsale no acepta un id externo en /returns.json, asi que la proteccion contra
 * duplicados es consultar antes: si el documento ya tiene una devolucion, no se
 * crea otra (err.code = 'RETURN_EXISTS'). Si falla, `postAttempted` dice si la
 * peticion de emision llego a salir.
 */
export async function issueCreditNote({ documentId, motive, parcial }) {
  let payload;
  try {
    const previas = await bsale.returnsForDocument(documentId);
    if (previas.length) {
      const ids = previas.map((r) => r.id).join(', ');
      const err = new Error(
        `Bsale ya tiene ${previas.length} devolucion(es) para el documento ${documentId} (id ${ids}). ` +
          'No se emite otra nota de credito: revisa en Bsale.'
      );
      err.code = 'RETURN_EXISTS';
      err.permanent = true;
      throw err;
    }
    payload = await buildReturnPayload({ documentId, motive, parcial });
  } catch (err) {
    err.postAttempted = false;
    throw err;
  }

  let devolucion;
  try {
    devolucion = await bsale.createReturn(payload);
  } catch (err) {
    err.postAttempted = true;
    throw err;
  }

  // La NC puede venir anidada en la devolucion segun el tipo de respuesta.
  const nc = devolucion?.creditNote || devolucion?.document || devolucion;

  log.info('bsale.credit_note_issued', {
    documentId,
    creditNoteId: nc?.id ?? null,
    number: nc?.number ?? null,
  });

  return {
    payload,
    creditNoteId: nc?.id ?? null,
    number: nc?.number != null ? String(nc.number) : null,
    url: nc?.urlPublicView || nc?.urlPdf || null,
    raw: devolucion,
  };
}
