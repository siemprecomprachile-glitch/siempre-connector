import { mercadolibreChannel } from './mercadolibre/index.js';
import { shopifyChannel } from './shopify/index.js';
import { falabellaChannel } from './falabella/index.js';
import { parisChannel } from './paris/index.js';
import { liderChannel } from './lider/index.js';

/**
 * Registro de canales. Agregar Ripley manana es crear una carpeta mas
 * con el mismo contrato: { name, label, enabled, fetchOrder(externalId) }.
 */
const registry = new Map([
  [mercadolibreChannel.name, mercadolibreChannel],
  [shopifyChannel.name, shopifyChannel],
  [falabellaChannel.name, falabellaChannel],
  [parisChannel.name, parisChannel],
  [liderChannel.name, liderChannel],
]);

export function getChannel(name) {
  const channel = registry.get(name);
  if (!channel) {
    const err = new Error(`Canal desconocido: ${name}`);
    err.permanent = true;
    throw err;
  }
  return channel;
}

export function allChannels() {
  return [...registry.values()];
}

export function enabledChannels() {
  return allChannels().filter((c) => c.enabled);
}
