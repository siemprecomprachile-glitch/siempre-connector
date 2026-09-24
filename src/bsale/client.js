import { config } from '../config.js';
import { log } from '../logger.js';

export class BsaleError extends Error {
  constructor(message, { status, body, permanent }) {
    super(message);
    this.name = 'BsaleError';
    this.status = status;
    this.body = body;
    // 4xx = la peticion esta mal, reintentar no sirve. 5xx / red = transitorio.
    this.permanent = permanent ?? (status >= 400 && status < 500 && status !== 429);
  }
}

async function request(method, path, body, { timeoutMs = 20000 } = {}) {
  if (!config.bsale.token) {
    throw new BsaleError('Falta BSALE_ACCESS_TOKEN', { status: 0, permanent: true });
  }

  const url = `${config.bsale.apiUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        access_token: config.bsale.token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new BsaleError(`Error de red hacia Bsale: ${err.message}`, {
      status: 0,
      permanent: false,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    const msg = parsed?.error || parsed?.message || parsed?.raw || res.statusText;
    log.warn('bsale.error', { method, path, status: res.status, msg });
    throw new BsaleError(`Bsale ${res.status}: ${msg}`, { status: res.status, body: parsed });
  }

  return parsed;
}

export const bsale = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),

  /** Tipos de documento configurados en la cuenta (boleta, factura, NC...). */
  documentTypes: () => request('GET', '/document_types.json?limit=50'),

  offices: () => request('GET', '/offices.json?limit=50'),

  paymentTypes: () => request('GET', '/payment_types.json?limit=50'),

  /** Busca una variante por SKU para descontar stock y usar el precio de Bsale. */
  async findVariantByCode(code) {
    if (!code) return null;
    try {
      const res = await request('GET', `/variants.json?code=${encodeURIComponent(code)}&limit=1`);
      return res?.items?.[0] || null;
    } catch (err) {
      log.warn('bsale.variant_lookup_failed', { code, msg: err.message });
      return null;
    }
  },

  createDocument: (payload) => request('POST', '/documents.json', payload),

  getDocument: (id) => request('GET', `/documents/${id}.json`),

  /** Lineas del documento original: sus ids son lo que la nota de credito devuelve. */
  documentDetails: (id) => request('GET', `/documents/${id}/details.json?limit=50`),

  /** Crea la devolucion y su nota de credito. */
  createReturn: (payload) => request('POST', '/returns.json', payload),
};
