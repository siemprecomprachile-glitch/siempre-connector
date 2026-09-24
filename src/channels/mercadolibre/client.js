import { config } from '../../config.js';
import { log } from '../../logger.js';
import { getAccessToken } from './auth.js';

const ML = config.mercadolibre;

class MlError extends Error {
  constructor(message, { status, permanent }) {
    super(message);
    this.name = 'MlError';
    this.status = status;
    this.permanent = permanent ?? (status >= 400 && status < 500 && status !== 429);
  }
}

async function api(path, { headers = {}, timeoutMs = 20000 } = {}) {
  const token = await getAccessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${ML.apiUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...headers,
      },
      signal: controller.signal,
    });
  } catch (err) {
    throw new MlError(`Error de red hacia Mercado Libre: ${err.message}`, {
      status: 0,
      permanent: false,
    });
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new MlError(
      `Mercado Libre ${res.status} en ${path}: ${data?.message || res.statusText}`,
      { status: res.status }
    );
  }
  return data;
}

export const ml = {
  getOrder: (orderId) => api(`/orders/${orderId}`),

  /**
   * Datos de facturacion que el comprador declaro (RUT, razon social, giro).
   * La v2 devuelve la info en `additional_info`; algunas cuentas todavia
   * responden el formato viejo, asi que se leen ambos.
   */
  async getBillingInfo(orderId) {
    try {
      return await api(`/orders/${orderId}/billing_info`, { headers: { 'x-version': '2' } });
    } catch (err) {
      log.warn('ml.billing_info_unavailable', { orderId, msg: err.message });
      return null;
    }
  },

  async getShipment(shipmentId) {
    if (!shipmentId) return null;
    try {
      return await api(`/shipments/${shipmentId}`, { headers: { 'x-format-new': 'true' } });
    } catch (err) {
      log.warn('ml.shipment_unavailable', { shipmentId, msg: err.message });
      return null;
    }
  },

  /** Ordenes recientes del vendedor: sirve para recuperar lo que el webhook perdio. */
  recentOrders({ sellerId = ML.sellerId, limit = 50, offset = 0 } = {}) {
    return api(
      `/orders/search?seller=${sellerId}&sort=date_desc&limit=${limit}&offset=${offset}`
    );
  },
};

export { MlError };
