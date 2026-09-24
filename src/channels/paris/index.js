import { config } from '../../config.js';
import { buildOrder } from '../../core/canonical.js';
import { formatRut } from '../../core/rut.js';
import { log } from '../../logger.js';

/**
 * Paris / Marketplace Cencosud.
 *
 * API propia de Cencosud (no es Mirakl). Documentacion:
 * https://developers.ecomm.cencosud.com/docs
 *
 * Puntos clave de esta API:
 *  - Autenticacion: se manda la API Key y devuelve un accessToken que dura
 *    4 horas. La documentacion pide expresamente NO pedirlo en cada llamada.
 *  - Paris trabaja con SUB-ORDENES de 10 digitos, no con ordenes. Una orden
 *    del comprador (9 digitos) puede tener varias sub-ordenes, una por
 *    despacho. Lo que se factura es la sub-orden.
 *  - La sub-orden trae `originInvoiceType`: el comprador ya declaro si quiere
 *    boleta o factura. No hay que adivinar.
 *  - Paris puede mandar webhook, pero lo configura su equipo de integraciones
 *    contra una URL publica. Mientras no este configurado, se consulta.
 *  - Despues de emitir el documento hay que SUBIRLO a Paris (POST /v1/invoice).
 *    Eso es lo que dispara el envio de la boleta al comprador.
 */

const ENDPOINTS = {
  auth: '/v1/auth/apiKey',
  subOrders: '/v3/sub-orders',
  subOrderDetail: (n) => `/v3/sub-orders/${encodeURIComponent(n)}/detail`,
  invoice: '/v1/invoice',
};

let sesion = null; // { token, expiraEn, sellerId }

class ParisError extends Error {
  constructor(message, { status, permanent } = {}) {
    super(message);
    this.name = 'ParisError';
    this.status = status;
    this.permanent = permanent ?? (status >= 400 && status < 500 && status !== 429 && status !== 401);
  }
}

/** Obtiene (y cachea) el accessToken. Dura 4 horas. */
async function getToken() {
  if (sesion && sesion.expiraEn > Date.now()) return sesion.token;

  if (!config.paris.apiKey) {
    throw new ParisError('Falta PARIS_API_KEY en el .env', { status: 0, permanent: true });
  }

  const res = await fetch(`${config.paris.apiUrl}${ENDPOINTS.auth}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.paris.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.accessToken) {
    throw new ParisError(`Paris auth ${res.status}: ${data?.message || res.statusText}`, {
      status: res.status,
      permanent: res.status === 401 || res.status === 403,
    });
  }

  const duraSeg = Number(data.expiresIn) || 14400;
  sesion = {
    token: data.accessToken,
    // 5 minutos de margen: la API castiga pedir el token de mas.
    expiraEn: Date.now() + (duraSeg - 300) * 1000,
    sellerId: data.jwtPayload?.seller_id || config.paris.sellerId || '',
  };

  log.info('paris.token_renovado', { sellerId: sesion.sellerId, duraSeg });
  return sesion.token;
}

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const token = await getToken();

  const res = await fetch(`${config.paris.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...headers,
    },
    body,
  });

  if (res.status === 401) {
    sesion = null; // token vencido antes de tiempo; el reintento lo renueva
    throw new ParisError('Paris 401: token rechazado', { status: 401, permanent: false });
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ParisError(`Paris ${res.status} en ${path}: ${data?.message || res.statusText}`, {
      status: res.status,
    });
  }
  return data;
}

async function sellerId() {
  await getToken();
  return sesion?.sellerId || config.paris.sellerId || '';
}

// --- mapeo -------------------------------------------------------------------

/** Una linea cancelada no se factura. */
function lineaActiva(item) {
  return !item.cancellationReasonId;
}

/**
 * Precio bruto de la linea. `basePrice` es el precio de venta con IVA.
 * Si tu cuenta trabaja los descuentos en `priceAfterDiscounts`, se cambia
 * PARIS_PRICE_FIELD en el .env y nada mas del codigo se toca.
 */
function precioBruto(item) {
  const campo = config.paris.priceField;
  const valor = Number(item[campo]);
  if (Number.isFinite(valor) && valor > 0) return valor;
  return Number(item.basePrice) || 0;
}

export function toCanonicalOrder(sub) {
  const items = (sub.items || []).filter(lineaActiva).map((it) => ({
    sku: it.sellerSku || it.sku || null,
    name: it.name || 'Producto',
    quantity: 1, // Paris repite la linea cuando se compran 2 del mismo producto.
    unitPrice: precioBruto(it),
    discount: 0,
  }));

  // El despacho viene en la sub-orden; algunas cuentas lo traen por linea.
  const despachoSub = Number(sub.dispatchCost) || 0;
  const despachoLineas = (sub.items || [])
    .filter(lineaActiva)
    .reduce((acc, it) => acc + (Number(it.shippingCost) || 0), 0);
  const shippingCost = despachoSub || despachoLineas;

  const cliente = sub.customer || {};
  const factura = sub.businessInvoice || null;
  const dirFactura = sub.billingAddress || sub.shippingAddress || {};

  // Paris entrega el RUT del comprador; documentType dice de que documento es.
  const rut =
    String(cliente.documentType || '').toUpperCase() === 'RUT'
      ? formatRut(cliente.documentNumber)
      : null;

  const rutEmpresa = factura
    ? formatRut(factura.documentNumber || factura.rut || factura.taxId)
    : null;

  return buildOrder({
    channel: 'paris',
    externalId: sub.subOrderNumber,
    reference: `Paris #${sub.subOrderNumber}`,
    createdAt: sub.originOrderDate || sub.createdAt,
    paid: true, // Paris entrega la sub-orden ya pagada por el marketplace.
    currency: 'CLP',
    total: items.reduce((acc, i) => acc + i.unitPrice * i.quantity, 0) + shippingCost,
    shippingCost,
    // Paris ya sabe que pidio el comprador: no hay que deducirlo.
    docHint: String(sub.originInvoiceType || '').toLowerCase() === 'factura' ? 'factura' : 'boleta',
    customer: {
      rut: rutEmpresa || rut,
      name: cliente.name || [dirFactura.firstName, dirFactura.lastName].filter(Boolean).join(' ') || 'Consumidor Final',
      businessName: factura?.businessName || factura?.name || null,
      activity: factura?.activity || factura?.giro || null,
      email: cliente.email || null,
      phone: dirFactura.phone || null,
      address: [dirFactura.address1, dirFactura.address2].filter(Boolean).join(' ') || null,
      city: dirFactura.city || null,
      municipality: dirFactura.city || null,
    },
    items,
  });
}

// --- canal -------------------------------------------------------------------

export const parisChannel = {
  name: 'paris',
  label: 'Paris',
  get enabled() {
    return config.paris.enabled;
  },

  async fetchOrder(subOrderNumber) {
    const sub = await call(ENDPOINTS.subOrderDetail(subOrderNumber));
    if (!sub?.subOrderNumber) {
      throw new ParisError(`Paris no devolvio la sub-orden ${subOrderNumber}`, { permanent: true });
    }

    const activas = (sub.items || []).filter(lineaActiva);
    if (!activas.length) {
      return { skip: 'todas las lineas de la sub-orden estan canceladas', raw: sub };
    }

    return { canonical: toCanonicalOrder(sub), raw: sub };
  },

  /**
   * Paris avisa por webhook solo cuando su equipo de integraciones lo configura
   * contra tu URL publica. Mientras tanto —y como respaldo— se consulta.
   */
  async listRecentOrderIds(limit = 50) {
    const desde = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const params = new URLSearchParams({
      sellerId: await sellerId(),
      gteCreatedAt: desde,
      limit: String(limit),
      offset: '0',
    });
    const res = await call(`${ENDPOINTS.subOrders}?${params}`);
    const ids = (res?.data || []).map((s) => String(s.subOrderNumber)).filter(Boolean);
    log.debug('paris.barrido', { encontradas: ids.length });
    return ids;
  },

  /** Si todas las lineas quedaron canceladas, la venta se cayo. */
  async checkRefund(subOrderNumber) {
    const sub = await call(ENDPOINTS.subOrderDetail(subOrderNumber));
    const items = sub?.items || [];
    if (!items.length) return { refunded: false };

    const canceladas = items.filter((i) => i.cancellationReasonId);
    if (canceladas.length === items.length) {
      const motivo = canceladas[0]?.cancellationReason?.name || 'cancelada en Paris';
      return { refunded: true, motive: `Sub-orden ${motivo}` };
    }
    if (canceladas.length) {
      return {
        refunded: true,
        partial: true,
        amount: canceladas.reduce((acc, i) => acc + precioBruto(i), 0),
        motive: 'Cancelacion parcial en Paris',
      };
    }
    return { refunded: false };
  },

  /**
   * Sube el documento emitido a Paris. ESTO es lo que hace que el comprador
   * reciba su boleta: sin este paso, para Paris la venta sigue sin documento.
   */
  async uploadInvoice({ externalId, docKind, number, pdfUrl }) {
    if (!pdfUrl) {
      throw new ParisError('Paris necesita la URL del PDF del documento', { permanent: true });
    }

    const form = new FormData();
    form.append('invoice_type', docKind === 'factura' ? 'factura' : 'boleta');
    form.append('order_number', String(externalId));
    if (number) form.append('invoice_number', String(number));
    form.append('description', `${docKind} ${number ?? ''} - sub-orden ${externalId}`.trim());
    form.append('url', pdfUrl);

    const res = await call(ENDPOINTS.invoice, { method: 'POST', body: form });
    log.info('paris.invoice_subida', { externalId, number });
    return res;
  },
};

/** Bota el token cacheado. Lo usan las pruebas y el panel al recargar claves. */
export function resetSession() {
  sesion = null;
}

export { ParisError };
