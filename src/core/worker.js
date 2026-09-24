import { orders, events } from '../db.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { processOrder, processRefund } from './process.js';
import { enabledChannels } from '../channels/index.js';

let running = false;

/** Reprocesa lo que quedo pendiente o en reintento. */
export async function tick() {
  if (running) return;
  running = true;
  try {
    const due = orders.dueForRetry(20);
    for (const record of due) {
      if (record.status === 'credit_retry') {
        await processRefund(record.channel, record.external_id, { motive: record.nc_motive });
      } else {
        await processOrder(record.channel, record.external_id);
      }
    }
  } catch (err) {
    log.error('worker.tick_failed', { msg: err.message });
  } finally {
    running = false;
  }
}

/**
 * Red de seguridad: si un webhook se pierde (ML reintenta, pero no para siempre),
 * este barrido encuentra las ventas que nunca llegaron y las factura igual.
 */
export async function sweepChannels() {
  for (const channel of enabledChannels()) {
    if (typeof channel.listRecentOrderIds !== 'function') continue;
    if (channel.isConnected && !channel.isConnected()) continue;
    try {
      const ids = await channel.listRecentOrderIds(50);
      let nuevas = 0;
      for (const id of ids) {
        if (!orders.find(channel.name, id)) {
          nuevas++;
          await processOrder(channel.name, id);
        }
      }
      if (nuevas) {
        events.add('info', `Barrido: ${nuevas} ventas recuperadas`, { channel: channel.name });
        log.info('worker.sweep_recovered', { channel: channel.name, nuevas });
      }
    } catch (err) {
      log.warn('worker.sweep_failed', { channel: channel.name, msg: err.message });
    }
  }
}

/**
 * Revisa ventas ya facturadas por si el comprador se arrepintio despues.
 * Mercado Libre y Shopify avisan por webhook, asi que para ellos esto es
 * respaldo; para Paris, Lider y Falabella es la unica forma de enterarse.
 *
 * Se revisan de a poco (las menos revisadas primero) para no gastar la cuota
 * de API de nadie.
 */
export async function sweepRefunds() {
  for (const channel of enabledChannels()) {
    if (typeof channel.checkRefund !== 'function') continue;
    if (channel.isConnected && !channel.isConnected()) continue;

    const candidatas = orders.pendingRefundCheck({ channel: channel.name, days: 30, limit: 25 });
    for (const record of candidatas) {
      try {
        const info = await channel.checkRefund(record.external_id);
        orders.update(record.id, { last_refund_check: Date.now() });
        if (info?.refunded) {
          await processRefund(channel.name, record.external_id, info);
        }
      } catch (err) {
        orders.update(record.id, { last_refund_check: Date.now() });
        log.warn('worker.refund_check_failed', {
          channel: channel.name,
          externalId: record.external_id,
          msg: err.message,
        });
      }
    }
  }
}

export function startWorker() {
  // Reintentos cada minuto.
  setInterval(tick, 60 * 1000).unref();

  // Barrido de canales. Mercado Libre y Shopify avisan solos, asi que para
  // ellos esto es red de seguridad. Paris, Lider y Falabella no avisan:
  // este barrido es la unica forma de enterarse de sus ventas.
  const cada = Math.max(1, config.rules.sweepIntervalMinutes) * 60 * 1000;
  setInterval(sweepChannels, cada).unref();

  // Devoluciones: mas espaciado, porque una devolucion nunca es urgente.
  setInterval(sweepRefunds, Math.max(15, config.rules.sweepIntervalMinutes * 3) * 60 * 1000).unref();

  // Primer barrido al arrancar, sin esperar el intervalo completo.
  setTimeout(sweepChannels, 10 * 1000).unref();

  log.info('worker.started', { sweepMinutes: config.rules.sweepIntervalMinutes });
}
