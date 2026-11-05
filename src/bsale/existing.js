import { bsale } from './client.js';
import { formatRut } from '../core/rut.js';

/**
 * ¿Esta venta ya se facturo por otra via (a mano, Pivot u otra integracion)?
 *
 * salesId solo protege contra documentos que emitio este conector: un
 * documento hecho a mano o por otra integracion no lo tiene. Antes de una
 * emision controlada se buscan en Bsale documentos parecidos:
 *  - mismo monto total, emitidos desde unos dias antes de la venta hasta hoy;
 *  - mismo RUT de cliente en ese rango (si la venta trae RUT).
 * Para cada candidato se revisa si su detalle o sus referencias mencionan el
 * numero de pedido: eso es un "ya facturado" seguro (`mentionsOrder`).
 *
 * Solo lee. Si Bsale no responde, lanza: sin verificar no se emite.
 */
export async function findExistingDocuments(order, externalId, { daysBefore = 3, max = 15 } = {}) {
  const desde = Math.floor(new Date(order.createdAt).getTime() / 1000) - daysBefore * 86400;
  const hasta = Math.floor(Date.now() / 1000) + 86400;
  const rango = `[${desde},${hasta}]`;

  const consultas = [`/documents.json?totalamount=${Math.round(order.total)}&emissiondaterange=${rango}&limit=50`];
  const rut = formatRut(order.customer?.rut);
  if (rut) {
    consultas.push(`/documents.json?clientcode=${encodeURIComponent(rut)}&emissiondaterange=${rango}&limit=50`);
  }

  const porId = new Map();
  for (const q of consultas) {
    const res = await bsale.get(q);
    for (const d of res?.items || []) porId.set(d.id, d);
  }

  const pedido = String(externalId);
  const candidatos = [];
  for (const d of [...porId.values()].slice(0, max)) {
    let textos = '';
    for (const sub of ['details', 'references']) {
      try {
        const r = await bsale.get(`/documents/${d.id}/${sub}.json?limit=50`);
        textos += JSON.stringify(r?.items || []);
      } catch {
        // sin detalle o sin referencias: se juzga con lo que hay
      }
    }
    candidatos.push({
      id: d.id,
      number: d.number ?? null,
      total: d.totalAmount ?? null,
      emissionDate: d.emissionDate ? new Date(Number(d.emissionDate) * 1000).toISOString().slice(0, 10) : null,
      documentType: d.document_type?.name || d.document_type?.id || null,
      url: d.urlPublicView || d.urlPdf || null,
      mismoMonto: Math.round(Number(d.totalAmount)) === Math.round(order.total),
      mentionsOrder: textos.includes(pedido) || JSON.stringify(d).includes(pedido),
    });
  }
  // Primero los que mencionan el pedido.
  return candidatos.sort((a, b) => Number(b.mentionsOrder) - Number(a.mentionsOrder));
}
