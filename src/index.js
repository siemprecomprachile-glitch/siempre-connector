import express from 'express';
import { config, assertConfig, channelStartInfo } from './config.js';
import { log } from './logger.js';
import { orders, events, storage } from './db.js';
import { probeChannel, previewOrder } from './core/diagnostics.js';
import { processOrder, processRefund, retryOrder } from './core/process.js';
import { startWorker, sweepChannels, sweepRefunds, tick } from './core/worker.js';
import { mercadolibreChannel } from './channels/mercadolibre/index.js';
import { shopifyChannel } from './channels/shopify/index.js';
import { allChannels } from './channels/index.js';
import { renderPanel } from './web/panel.js';
import { bsale } from './bsale/client.js';
import { resolveDocTypeIds, docTypeSummary } from './bsale/doctypes.js';
import { renderPreviewPage, renderResultPage } from './web/prueba.js';
import { runSalesIdSelfTest } from './bsale/selftest.js';

/** Estado de cada canal para el panel y para /health. */
function channelStatus() {
  return allChannels().map((c) => ({
    name: c.name,
    label: c.label,
    enabled: c.enabled,
    connected: typeof c.isConnected === 'function' ? c.isConnected() : undefined,
    ...channelStartInfo(c.name),
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
    bsaleDocTypes: docTypeSummary(),
    autoCreditNotes: config.rules.autoCreditNotes,
    storage: storage.info(),
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


// Diagnostico de solo lectura (ver core/diagnostics.js): prueba credenciales y
// lectura de pedidos con el canal apagado. No registra ventas ni emite nada.
//   /panel/canales/paris/probar?token=...
//   /panel/canales/paris/pedido/1234567890?token=...
app.get('/panel/canales/:name/probar', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    res.json(await probeChannel(req.params.name, { limit }));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/panel/canales/:name/pedido/:id', requireAdmin, async (req, res) => {
  try {
    res.json(await previewOrder(req.params.name, req.params.id));
  } catch (err) {
    res.status(400).json({ ok: false, sentToBsale: false, error: err.message });
  }
});

// Prueba controlada de UN pedido (ver web/prueba.js). GET = solo mirar;
// emitir es un POST aparte que exige escribir el numero de pedido. Funciona con
// el canal apagado y no barre nada mas.
app.get('/panel/prueba', requireAdmin, (req, res) => {
  const canal = encodeURIComponent(String(req.query.canal || ''));
  const pedido = encodeURIComponent(String(req.query.pedido || '').trim());
  res.redirect(`/panel/prueba/${canal}/${pedido}?token=${encodeURIComponent(req.query.token)}`);
});

app.get('/panel/prueba/:name/:id', requireAdmin, async (req, res) => {
  const { name, id } = req.params;
  let preview = null;
  let error = null;
  try {
    preview = await previewOrder(name, id);
  } catch (err) {
    error = err.message;
  }
  res.type('html').send(
    renderPreviewPage({ token: String(req.query.token), name, id, preview, error, declareSii: config.bsale.declareSii })
  );
});

app.post('/panel/prueba/:name/:id/emitir', requireAdmin, async (req, res) => {
  const { name, id } = req.params;
  const token = String(req.body.token || req.query.token || '');
  const show = (status, data) => res.status(status).type('html').send(renderResultPage({ token, name, id, ...data }));

  if (String(req.body.confirm || '').trim() !== String(id)) {
    return show(400, { error: 'No se emitio: para confirmar hay que escribir el numero de pedido exacto.' });
  }
  let preview;
  try {
    preview = await previewOrder(name, id);
  } catch (err) {
    return show(400, { error: `No se emitio: no se pudo releer el pedido (${err.message}).` });
  }
  if (preview.skip || preview.retryLater) {
    return show(409, { error: `No se emitio: ${preview.skip || preview.retryLater}` });
  }
  if (preview.existingDocument) {
    return show(409, { error: `No se emitio: el pedido ya tiene ${preview.existingDocument.kind} N° ${preview.existingDocument.number}.` });
  }
  const expectedTotal = Number(req.body.expectedTotal);
  if (preview.docKind !== req.body.expectedKind || preview.order.total !== expectedTotal) {
    return show(409, {
      error:
        `No se emitio: el pedido cambio desde la vista previa ` +
        `(antes ${req.body.expectedKind} por ${expectedTotal}, ahora ${preview.docKind} por ${preview.order.total}). Vuelve a revisarlo.`,
    });
  }

  events.add('info', `Prueba controlada: emision manual de ${name} #${id}`, { channel: name, orderRef: id });
  const result = await processOrder(name, id, { manual: true });
  show(result.status === 'done' ? 200 : 502, { result });
});

// Validacion de salesId en la EMPRESA DE PRUEBAS de Bsale (bsale/selftest.js).
// Solo corre si BSALE_TEST_ACCESS_TOKEN esta definido y es distinto del real.
app.get('/panel/bsale/prueba-salesid', requireAdmin, (req, res) => {
  const listo = Boolean(process.env.BSALE_TEST_ACCESS_TOKEN);
  res.type('html').send(
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px;line-height:1.5}</style>` +
      `<h2>Validar salesId en la empresa de pruebas de Bsale</h2>` +
      (listo
        ? `<p>Crea boletas (y una factura) <b>de prueba</b> con declareSii=0 en la empresa del token BSALE_TEST_ACCESS_TOKEN. No usa el token real.</p>` +
          `<form method="post"><input type="hidden" name="token" value="${String(req.query.token).replace(/"/g, '&quot;')}">` +
          `<p>Escribe PRUEBA: <input name="confirm" autocomplete="off" required> <button type="submit">Ejecutar</button></p></form>`
        : `<p>Falta <b>BSALE_TEST_ACCESS_TOKEN</b> en Render (token de la empresa de pruebas de account.bsale.dev).</p>`)
  );
});

app.post('/panel/bsale/prueba-salesid', requireAdmin, async (req, res) => {
  if (String(req.body.confirm || '').trim() !== 'PRUEBA') return res.status(400).send('No se ejecuto: escribe PRUEBA.');
  try {
    const r = await runSalesIdSelfTest({
      token: process.env.BSALE_TEST_ACCESS_TOKEN,
      realToken: config.bsale.token,
      apiUrl: process.env.BSALE_TEST_API_URL,
    });
    res.json(r);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Utilidad: muestra los IDs de Bsale que el conector tiene activos (deducidos solos
// por codigo SII o puestos a mano) y lista los tipos de documento y formas de pago.
// Abrir en el navegador: /panel/bsale/tipos?token=TU_ADMIN_TOKEN
app.get('/panel/bsale/tipos', requireAdmin, async (_req, res) => {
  if (!config.bsale.token) return res.status(400).send('Falta BSALE_ACCESS_TOKEN en las variables de entorno.');
  try {
    const ids = await resolveDocTypeIds({ force: true });
    const [dt, pt] = await Promise.all([bsale.documentTypes(), bsale.paymentTypes()]);
    const esc = (v) => String(v ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const active = [ids.boletaTypeId, ids.facturaTypeId, ids.notaCreditoTypeId];
    const mark = (id) => (active.includes(id) ? ' style="background:#e6ffed"' : '');
    const dtRows = (dt.items || []).map((d) => `<tr${mark(d.id)}><td><b>${d.id}</b></td><td>${esc(d.name)}</td><td>${esc(d.codeSii)}</td></tr>`).join('');
    const ptRows = (pt.items || []).map((p) => `<tr><td><b>${p.id}</b></td><td>${esc(p.name)}</td></tr>`).join('');
    const ok = ids.complete;
    res.type('html').send(
      `<meta charset="utf-8"><style>body{font-family:sans-serif;padding:24px;line-height:1.5;max-width:900px}table{border-collapse:collapse;margin:8px 0 24px}td,th{border:1px solid #ccc;padding:6px 14px;text-align:left}th{background:#f3f3f3}pre{background:#f6f8fa;padding:12px;border-radius:6px}.ok{color:#1a7f37}.bad{color:#b42318}</style>` +
        `<h2>IDs de Bsale activos en el conector</h2>` +
        `<p class="${ok ? 'ok' : 'bad'}"><b>${ok ? 'Listo: el conector ya tiene los 3 IDs (filas verdes abajo).' : 'Faltan IDs: no se encontro un tipo con ese codigo SII. Ponlos a mano en Render.'}</b></p>` +
        `<pre>BSALE_DOCTYPE_BOLETA_ID=${ids.boletaTypeId ?? ''}\nBSALE_DOCTYPE_FACTURA_ID=${ids.facturaTypeId ?? ''}\nBSALE_DOCTYPE_NOTA_CREDITO_ID=${ids.notaCreditoTypeId ?? ''}</pre>` +
        `<p>Se deducen solos por codigo SII (boleta 39, factura 33, nota de credito 61). Si quieres usar otro tipo, pon su ID en Render y ese manda.</p>` +
        `<h2>Tipos de documento de tu cuenta</h2>` +
        `<table><tr><th>ID</th><th>Nombre</th><th>codeSii</th></tr>${dtRows}</table>` +
        `<h2>Formas de pago (opcional: BSALE_PAYMENT_TYPE_ID)</h2>` +
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
  log.info('server.storage', storage.info());
  resolveDocTypeIds();
  startWorker();
});

export default app;
