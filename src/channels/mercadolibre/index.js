import { ml } from './client.js';
import { toCanonicalOrder, isCancelled, isPaid, refundInfo } from './mapper.js';
import { authorizationUrl, exchangeCode, connectionInfo, isConnected } from './auth.js';
import { config } from '../../config.js';

export const mercadolibreChannel = {
  name: 'mercadolibre',
  label: 'Mercado Libre',
  get enabled() {
    return config.mercadolibre.enabled;
  },
  isConnected,
  connectionInfo,
  authorizationUrl,
  exchangeCode,

  /** Trae la orden completa y la deja en formato canonico. */
  async fetchOrder(externalId) {
    const order = await ml.getOrder(externalId);

    if (isCancelled(order)) {
      return { skip: `orden ${order.status} en Mercado Libre`, raw: order };
    }
    if (config.rules.requirePaid && !isPaid(order)) {
      return { retryLater: `orden todavia no pagada (${order.status})`, raw: order };
    }

    const [billing, shipment] = await Promise.all([
      ml.getBillingInfo(externalId),
      ml.getShipment(order.shipping?.id),
    ]);

    return {
      canonical: toCanonicalOrder({ order, billing, shipment }),
      raw: { order, billing, shipment },
    };
  },

  /**
   * Para una venta que ya facturamos: mira si se cayo despues.
   * Mercado Libre vuelve a avisar por webhook cuando cambia el estado, asi
   * que casi siempre llegamos aca por un aviso, no por el barrido.
   */
  async checkRefund(externalId) {
    const order = await ml.getOrder(externalId);
    return refundInfo(order);
  },

  /** Relleno: revisa las ordenes recientes por si un webhook se perdio. */
  async listRecentOrderIds(limit = 50) {
    const res = await ml.recentOrders({ limit });
    return (res?.results || []).map((o) => String(o.id));
  },
};
