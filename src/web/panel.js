const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const clp = (n) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('es-CL', { maximumFractionDigits: 0 });

const fecha = (ms) =>
  ms
    ? new Date(ms).toLocaleString('es-CL', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const CHANNEL_LABEL = {
  mercadolibre: 'Mercado Libre',
  shopify: 'Shopify',
  falabella: 'Falabella',
  paris: 'Paris',
  lider: 'Lider',
};

const STATUS_LABEL = {
  done: 'Emitido',
  pending: 'Pendiente',
  processing: 'Procesando',
  retry: 'Reintentando',
  failed: 'Con error',
  skipped: 'Omitida',
  credited: 'Anulado con NC',
  credit_retry: 'NC reintentando',
  credit_failed: 'NC con error',
  review: 'Necesita tu mano',
};

export function renderPanel({ token, counts, orders, events, ml, missingConfig, channels = [] }) {
  const t = encodeURIComponent(token);

  const avisos = [];
  if (missingConfig.length) {
    avisos.push(`Falta configurar en el .env: <b>${missingConfig.join(', ')}</b>`);
  }
  if (!ml.connected) {
    avisos.push(
      `Mercado Libre no esta conectado. <a href="/oauth/mercadolibre">Conectar ahora</a>`
    );
  } else if (ml.expired) {
    avisos.push('El token de Mercado Libre expiro; se renovara solo en el proximo pedido.');
  }

  const tarjetas = [
    ['Emitidos', counts.done || 0, 'ok'],
    ['En cola', (counts.pending || 0) + (counts.retry || 0) + (counts.credit_retry || 0), 'warn'],
    ['Con error', (counts.failed || 0) + (counts.credit_failed || 0) + (counts.review || 0), 'bad'],
    ['Anulados con NC', counts.credited || 0, 'muted'],
  ];

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Siempre Connector</title>
<style>
  :root {
    --bg: #f6f7f9; --card: #fff; --line: #e4e7ec; --text: #16191d;
    --muted: #6b7280; --ok: #0a7d35; --warn: #b45309; --bad: #b42318; --accent: #1a56db;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#111418; --card:#191d23; --line:#2a2f37; --text:#e8eaed;
            --muted:#9aa3ae; --ok:#3ecf6e; --warn:#f0a03c; --bad:#f0685e; --accent:#6ea8ff; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:1100px; margin:0 auto; padding:24px 16px 64px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 20px; }
  .aviso { background:#fff4e5; color:#7a4a00; border:1px solid #f0c48a;
           padding:10px 14px; border-radius:8px; margin-bottom:12px; }
  @media (prefers-color-scheme: dark) { .aviso { background:#2b2114; color:#f0c48a; border-color:#5c4426; } }
  .canales { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:18px; }
  .canal { display:inline-flex; align-items:center; gap:7px; background:var(--card);
           border:1px solid var(--line); border-radius:99px; padding:6px 13px; font-size:13px; }
  .canal i { width:7px; height:7px; border-radius:50%; background:var(--muted); flex:none; }
  .canal.on i { background:var(--ok); }
  .canal.off { opacity:.55; }
  .canal b { font-weight:500; color:var(--muted); font-size:11px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .card .n { font-size:26px; font-weight:600; }
  .card .l { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .ok .n{color:var(--ok)} .warn .n{color:var(--warn)} .bad .n{color:var(--bad)} .muted .n{color:var(--muted)}
  .bar { display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap; }
  button, .btn { background:var(--accent); color:#fff; border:0; border-radius:7px;
                 padding:8px 14px; font-size:13px; cursor:pointer; text-decoration:none; display:inline-block; }
  button.ghost { background:transparent; color:var(--accent); border:1px solid var(--line); }
  .tablewrap { overflow-x:auto; background:var(--card); border:1px solid var(--line); border-radius:10px; }
  table { width:100%; border-collapse:collapse; min-width:760px; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.04em;
       color:var(--muted); padding:10px 12px; border-bottom:1px solid var(--line); font-weight:600; }
  td { padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:last-child td { border-bottom:0; }
  .pill { display:inline-block; padding:2px 8px; border-radius:99px; font-size:11px; font-weight:600; }
  .p-done{background:#e3f5e9;color:#0a7d35}
  .p-failed,.p-credit_failed{background:#fde8e6;color:#b42318}
  .p-retry,.p-pending,.p-processing,.p-credit_retry,.p-review{background:#fdf0dc;color:#b45309}
  .p-skipped{background:#eceef1;color:#6b7280}
  .p-credited{background:#e8e6f5;color:#4b3f9e}
  @media (prefers-color-scheme: dark) {
    .p-done{background:#14311f;color:#3ecf6e}
    .p-failed,.p-credit_failed{background:#3a1a18;color:#f0685e}
    .p-retry,.p-pending,.p-processing,.p-credit_retry,.p-review{background:#332512;color:#f0a03c}
    .p-skipped{background:#23272e;color:#9aa3ae}
    .p-credited{background:#221f38;color:#a89ef0}
  }
  .anulado { text-decoration: line-through; opacity:.6; }
  .err { color:var(--bad); font-size:12px; max-width:320px; }
  .muted-txt { color:var(--muted); font-size:12px; }
  h2 { font-size:15px; margin:28px 0 10px; }
  a { color:var(--accent); }
</style>
</head>
<body>
<div class="wrap">
  <h1>Siempre Connector</h1>
  <p class="sub">Facturacion automatica en Bsale — todos tus canales de venta en un solo lugar.</p>

  ${avisos.map((a) => `<div class="aviso">${a}</div>`).join('')}

  <div class="canales">
    ${channels
      .map((c) => {
        const on = c.enabled && c.connected !== false;
        const estado = !c.enabled ? 'Apagado' : c.connected === false ? 'Sin conectar' : 'Activo';
        return `<span class="canal ${on ? 'on' : 'off'}"><i></i>${esc(c.label)}<b>${estado}</b></span>`;
      })
      .join('')}
  </div>

  <div class="cards">
    ${tarjetas
      .map(
        ([label, n, cls]) =>
          `<div class="card ${cls}"><div class="n">${n}</div><div class="l">${label}</div></div>`
      )
      .join('')}
  </div>

  <div class="bar">
    <form method="post" action="/panel/sweep">
      <input type="hidden" name="token" value="${esc(token)}">
      <button type="submit">Buscar ventas nuevas ahora</button>
    </form>
    <a class="btn ghost" href="/panel?token=${t}">Actualizar</a>
    <a class="btn ghost" href="/health">Estado tecnico</a>
  </div>

  <h2>Ultimas ordenes</h2>
  <div class="tablewrap">
    <table>
      <thead>
        <tr>
          <th>Canal</th><th>Orden</th><th>Cliente</th><th>Total</th>
          <th>Documento</th><th>Estado</th><th>Fecha</th><th></th>
        </tr>
      </thead>
      <tbody>
        ${
          orders.length
            ? orders
                .map(
                  (o) => `
        <tr>
          <td>${esc(CHANNEL_LABEL[o.channel] || o.channel)}</td>
          <td>${esc(o.external_id)}</td>
          <td>${esc(o.customer_name || '—')}<div class="muted-txt">${esc(o.customer_rut || '')}</div></td>
          <td>${clp(o.total)}</td>
          <td>${
            o.bsale_number
              ? `<span class="${o.nc_number ? 'anulado' : ''}">${esc(o.doc_kind || '')} N° ${esc(
                  o.bsale_number
                )}</span>${
                  o.bsale_url ? ` <a href="${esc(o.bsale_url)}" target="_blank" rel="noopener">ver</a>` : ''
                }`
              : '—'
          }${
            o.nc_number
              ? `<div class="muted-txt">NC N° ${esc(o.nc_number)}${
                  o.nc_url ? ` <a href="${esc(o.nc_url)}" target="_blank" rel="noopener">ver</a>` : ''
                }${o.nc_motive ? ` · ${esc(o.nc_motive)}` : ''}</div>`
              : ''
          }</td>
          <td><span class="pill p-${esc(o.status)}">${esc(STATUS_LABEL[o.status] || o.status)}</span>
              ${o.last_error ? `<div class="err">${esc(o.last_error)}</div>` : ''}</td>
          <td class="muted-txt">${fecha(o.created_at)}</td>
          <td>${
            ['failed', 'retry', 'credit_failed', 'credit_retry'].includes(o.status)
              ? `<form method="post" action="/panel/retry/${o.id}">
                   <input type="hidden" name="token" value="${esc(token)}">
                   <button class="ghost" type="submit">Reintentar</button>
                 </form>`
              : ''
          }</td>
        </tr>`
                )
                .join('')
            : `<tr><td colspan="8" class="muted-txt">Todavia no llega ninguna orden.</td></tr>`
        }
      </tbody>
    </table>
  </div>

  <h2>Actividad reciente</h2>
  <div class="tablewrap">
    <table>
      <thead><tr><th>Cuando</th><th>Canal</th><th>Orden</th><th>Mensaje</th></tr></thead>
      <tbody>
        ${
          events.length
            ? events
                .map(
                  (e) => `<tr>
                    <td class="muted-txt">${fecha(e.created_at)}</td>
                    <td>${esc(CHANNEL_LABEL[e.channel] || e.channel || '—')}</td>
                    <td>${esc(e.order_ref || '—')}</td>
                    <td${e.level === 'error' ? ' class="err"' : ''}>${esc(e.message)}</td>
                  </tr>`
                )
                .join('')
            : `<tr><td colspan="4" class="muted-txt">Sin actividad.</td></tr>`
        }
      </tbody>
    </table>
  </div>
</div>
</body>
</html>`;
}
