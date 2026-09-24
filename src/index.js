import express from 'express';
import { config, assertConfig } from './config.js';
import { log } from './logger.js';
import { orders, events } from './db.js';
import { processOrder, processRefund, retryOrder } from './core/process.js';
import { startWorker, sweepChannels, sweepRefunds, tick } from './core/worker.js';
import { mercadolibreChannel } from './channels/mercadolibre/index.js';
import { shopifyChannel } from './channels/shopify/index.js';
import { allChannels } from './channels/index.js';
import { renderPanel } from './web/panel.js';

/** Estado de cada canal para el panel y para /health. */
function channelStatus() {
  return allChannels().map((c) => ({
    name: c.name,
    label: c.label,
    enabled: c.enabled,
    connected: typeof c.isConnected === 'function' ? c.isConnected() : undefined,
  }));
}

const app = express();
app.disable('x-powered-by');

// Shopify firma el cuerpo crudo: hay que guardarlo antes de parsear.
app.use(
  express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);
app.use(express.urlencoded({ extended: false }));

// --- salud -------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    env: config.env,
    missingConfig: assertConfig(),
    channels: channelStatus(),
    mercadolibre: mercadolibreChannel.connectionInfo(),
    orders: orders.counts(),
  });
});

// --- OAuth Mercado Libre -----------------------------------------------------

app.get('/oauth/mercadolibre', (_req, res) => {
  if (!config.mercadolibre.enabled) {
    return res.status(400).send('Falta ML_CLIENT_ID / ML_CLIENT_SECRET en el .env');
  }
  res.redirect(mercadolibreChannel.authorizationUrl());
});

app.get('/oauth/mercadolibre/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.status(400).send(`Mercado Libre rechazo la autorizacion: ${error || 'sin codigo'}`);
  }
  try {
    await mercadolibreChannel.exchangeCode(String(code));
    events.add('info', 'Mercado Libre conectado', { channel: 'mercadolibre' });
    res.send(
      '<h2>Listo. Mercado Libre quedo conectado.</h2><p>Ya puedes cerrar esta ventana.</p>'
    );
  } catch (err) {
    log.error('oauth.callback_failed', { msg: err.message });
    res.status(500).send(`Error conectando Mercado Libre: ${err.message}`);
  }
});

// --- Webhook Mercado Libre ---------------------------------------------------

app.post('/webhooks/mercadolibre', (req, res) => {
  // ML corta la conexion a los 500ms y reintenta si no ve un 200:
  // se responde primero y se procesa despues.
  res.sendStatus(200);

  const { topic, resource, user_id: userId } = req.body || {};
  if (!topic || !resource) return;

  if (!String(topic).startsWith('orders')) {
    log.debug('ml.webhook_ignored', { topic });
    return;
  }

  if (config.mercadolibre.sellerId && String(userId) !== String(config.mercadolibre.sellerId)) {
    log.warn('ml.webhook_other_seller', { userId });
    return;
  }

  const orderId = String(resource).split('/').filter(Boolean).pop();
  log.info('ml.webhook', { topic, orderId });

  processOrder('mercadolibre', orderId).catch((err) =>
    log.error('ml.webhook_process_failed', { orderId, msg: err.message })
  );
});

// --- Webhook Shopify ---------------------------------------------------------

app.post('/webhooks/shopify', (req, res) => {
  if (!config.shopify.enabled) return res.sendStatus(404);

  const valid = shopifyChannel.verifyWebhook(req.rawBody, req.get('X-Shopify-Hmac-Sha256'));
  if (!valid) {
    log.warn('shopify.webhook_bad_signature');
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  const payload = req.body;
  const topic = req.get('X-Shopify-Topic') || 'orders/paid';

  // Devolucion o cancelacion de una venta ya facturada -> nota de credito.
  if (topic === 'refunds/create' || topic === 'orders/cancelled') {
    const orderId = payload.order_id || payload.id;
    const motive =
      topic === 'orders/cancelled'
        ? 'Pedido cancelado en Shopify'
        : 'Devolucion registrada en Shopify';
    processRefund('shopify', orderId, { motive }).catch((err) =>
      log.error('shopify.refund_failed', { orderId, msg: err.message })
    );
    return;
  }

  try {
    const canonical = shopifyChannel.toCanonicalOrder(payload);
    if (config.rules.requirePaid && !canonical.paid) {
      log.info('shopify.webhook_unpaid', { id: payload.id });
      return;
    }
    processOrder('shopify', payload.id, { canonicalOverride: canonical }).catch((err) =>
      log.error('shopify.process_failed', { id: payload.id, msg: err.message })
    );
  } catch (err) {
    events.add('error', `Shopify: ${err.message}`, { channel: 'shopify', orderRef: payload?.id });
    log.error('shopify.map_failed', { id: payload?.id, msg: err.message });
  }
});

// --- Webhook Paris -----------------------------------------------------------

/**
 * Paris notifica creacion y cambios de ordenes a una URL publica que su equipo
 * de integraciones configura. El cuerpo trae orderNumber y sellerId.
 *
 * Ojo: orderNumber puede ser la orden del comprador (9 digitos) o la sub-orden
 * (10). Lo que se factura es la sub-orden, asi que con 9 digitos se le pregunta
 * a Paris cuales son sus sub-ordenes.
 */
app.post('/webhooks/paris', (req, res) => {
  if (!config.paris.enabled) return res.sendStatus(404);
  res.sendStatus(200);

  const { orderNumber, subOrderNumber, sellerId } = req.body || {};
  const numero = String(subOrderNumber || orderNumber || '').trim();
  if (!numero) return;

  if (config.paris.sellerId && sellerId && String(sellerId) !== String(config.paris.sellerId)) {
    log.warn('paris.webhook_otro_seller', { sellerId });
    return;
  }

  log.info('paris.webhook', { numero });

  // Sub-orden (10 digitos): se procesa directo. Orden (9): el barrido la toma.
  if (numero.length >= 10) {
    processOrder('paris', numero).catch((err) =>
      log.error('paris.webhook_process_failed', { numero, msg: err.message })
    );
  } else {
    sweepChannels().catch((err) => log.warn('paris.webhook_sweep_failed', { msg: err.message }));
  }
});

// --- Panel -------------------------------------------------------------------

function requireAdmin(req, res, next) {
  const token = req.query.token || req.get('X-Admin-Token') || req.body?.token;
  if (!config.adminToken || token !== config.adminToken) {
    return res.status(401).send('Token invalido. Usa /panel?token=TU_ADMIN_TOKEN');
  }
  next();
}

app.get('/panel', requireAdmin, (req, res) => {
  res.type('html').send(
    renderPanel({
      token: String(req.query.token),
      counts: orders.counts(),
      orders: orders.recent(80),
      events: events.recent(40),
      ml: mercadolibreChannel.connectionInfo(),
      missingConfig: assertConfig(),
      channels: channelStatus(),
    })
  );
});

app.post('/panel/retry/:id', requireAdmin, async (req, res) => {
  try {
    await retryOrder(Number(req.params.id));
  } catch (err) {
    log.warn('panel.retry_failed', { msg: err.message });
  }
  res.redirect(`/panel?token=${encodeURIComponent(req.body.token || req.query.token)}`);
});

app.post('/panel/sweep', requireAdmin, async (req, res) => {
  await sweepChannels();
  await sweepRefunds();
  await tick();
  res.redirect(`/panel?token=${encodeURIComponent(req.body.token || req.query.token)}`);
});


// Utilidad: lista los tipos de documento y formas de pago de Bsale con sus IDs.
// Abrir en el navegador: /panel/bsale/tipos?token=TU_ADMIN_TOKEN
app.get('/panel/bsale/tipos', requireAdmin, async (_req, res) => {
  const base = config.bsale.apiUrl;
  const token = config.bsale.token;
  if (!token) return res.status(400).send('Falta BSALE_ACCESS_TOKEN en las variables de entorno.');
  try {
    const h = { access_token: token, Accept: 'application/json' };
    const get = async (p) => {
      const r = await fetch(`${base}${p}`, { headers: h });
      if (!r.ok) throw new Error(`${p} devolvio HTTP ${r.status}`);
      return r.json();
    };
    const [dt, pt] = await Promise.all([
      get('/document_types.json?limit=50'),
      get('/payment_types.json?limit=50'),
    ]);
    const esc = (v) => String(v ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const dtRows = (dt.items || []).map((d) => `<tr><td><b>${d.id}</b></td><td>${esc(d.name)}</td><td>${esc(d.codeSii)}</td></tr>`).join('');
    const ptRows = (pt.items || []).map((p) => `<tr><td><b>${p.id}</b></td><td>${esc(p.name)}</td></tr>`).join('');
    res.type('html').send(
      `<meta charset="utf-8"><style>body{font-family:sans-serif;padding:24px;line-height:1.5}table{border-collapse:collapse;margin:8px 0 24px}td,th{border:1px solid #ccc;padding:6px 14px;text-align:left}th{background:#f3f3f3}b{font-size:16px}</style>` +
        `<h2>Tipos de documento — usa la columna ID</h2>` +
        `<table><tr><th>ID</th><th>Nombre</th><th>codeSii</th></tr>${dtRows}</table>` +
        `<p><b>Boleta</b> electronica = codeSii <b>39</b> &nbsp;·&nbsp; <b>Factura</b> = codeSii <b>33</b> &nbsp;·&nbsp; <b>Nota de credito</b> = codeSii <b>61</b></p>` +
        `<h2>Formas de pago</h2>` +
        `<table><tr><th>ID</th><th>Nombre</th></tr>${ptRows}</table>`
    );
  } catch (e) {
    res.status(500).send('Error consultando Bsale: ' + e.message);
  }
});

// --- arranque ----------------------------------------------------------------

const missing = assertConfig();
if (missing.length) {
  log.warn('config.incomplete', { missing });
}

app.listen(config.port, '0.0.0.0', () => {
  log.info('server.listening', { port: config.port, publicUrl: config.publicUrl });
  log.info('server.webhook_url', { url: `${config.publicUrl}/webhooks/mercadolibre` });
  startWorker();
});

export default app;
