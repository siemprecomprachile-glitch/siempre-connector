/**
 * Prueba controlada de UN pedido: primero se ve el documento y el monto que se
 * emitirian; emitir es un boton aparte que exige escribir el numero de pedido.
 * No enciende el canal ni barre nada.
 */

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const clp = (n) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('es-CL', { maximumFractionDigits: 0 });

const STYLE = `<style>
body{font-family:system-ui,sans-serif;max-width:860px;margin:0 auto;padding:24px 16px;line-height:1.5;color:#1d1d1f;background:#fff}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}
table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border-bottom:1px solid #e5e5e5;padding:6px 8px;text-align:left;vertical-align:top}
th{font-size:12px;color:#666;text-transform:uppercase}
.box{border-radius:8px;padding:12px 14px;margin:12px 0}.warn{background:#fdf0dc;color:#7a4500}.bad{background:#fde8e6;color:#8a1c12}.ok{background:#e6f6ec;color:#14532d}
.total{font-size:28px;font-weight:700}.muted{color:#666;font-size:13px}
input[name=confirm]{font-size:16px;padding:8px;width:220px}button{font-size:16px;padding:9px 16px;border-radius:6px;border:0;background:#b42318;color:#fff;cursor:pointer}
a{color:#0b57d0}
@media (prefers-color-scheme: dark){body{background:#151515;color:#eee}td,th{border-color:#333}.warn{background:#332512;color:#f0c07c}.bad{background:#3a1a18;color:#f3a29a}.ok{background:#12301f;color:#9ee0b5}a{color:#8ab4f8}}
</style>`;

function page(title, body) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>${STYLE}</head>
<body>${body}</body></html>`;
}

function avisoSii(declareSii) {
  return declareSii
    ? `<div class="box bad"><b>BSALE_DECLARE_SII=1:</b> el documento se crea en Bsale y se envia al SII. Es un documento tributario real.</div>`
    : `<div class="box warn"><b>BSALE_DECLARE_SII=0 no es una simulacion:</b> el documento SE CREA en Bsale con su numero (y descuenta stock si el SKU existe en Bsale). Solo no se envia al SII.</div>`;
}

export function renderPreviewPage({ token, name, id, preview, error, declareSii }) {
  const back = `<p class="muted"><a href="/panel?token=${encodeURIComponent(token)}">Volver al panel</a></p>`;
  const head = `<h1>Prueba controlada · ${esc(name)} #${esc(id)}</h1>
<p class="muted">Solo lectura hasta que confirmes abajo. No enciende el canal ni barre otras ventas.</p>`;

  if (error) {
    return page('Prueba controlada', `${head}<div class="box bad">No se pudo leer el pedido: ${esc(error)}</div>${back}`);
  }
  if (preview.skip || preview.retryLater) {
    return page(
      'Prueba controlada',
      `${head}<div class="box warn">Este pedido no se factura ahora: ${esc(preview.skip || preview.retryLater)}</div>${back}`
    );
  }

  const o = preview.order;
  const c = o.customer || {};
  const items = (o.items || [])
    .map(
      (i) =>
        `<tr><td>${esc(i.quantity)}</td><td>${esc(i.name)}${i.sku ? ` <span class="muted">(${esc(i.sku)})</span>` : ''}</td><td>${clp(i.unitPrice)}</td><td>${clp(i.unitPrice * i.quantity - (i.discount || 0))}</td></tr>`
    )
    .join('');

  const yaTiene = preview.existingDocument;
  const avisos = [];
  if (yaTiene) {
    avisos.push(
      `<div class="box ok">Este pedido ya tiene ${esc(yaTiene.kind || 'documento')} N° ${esc(yaTiene.number)}${
        yaTiene.url ? ` (<a href="${esc(yaTiene.url)}" target="_blank" rel="noopener">ver</a>)` : ''
      }. No se emite otro.</div>`
    );
  }
  if (preview.beforeStart) {
    avisos.push(
      `<div class="box warn">La venta es anterior a la fecha de inicio del canal (${esc(preview.startAt)}). Puede que ya la hayas facturado a mano: revisa Bsale antes de emitir.</div>`
    );
  }
  if (preview.registeredStatus && !yaTiene) {
    avisos.push(`<div class="box warn">Ya esta registrada en el conector con estado <b>${esc(preview.registeredStatus)}</b>.</div>`);
  }
  if (preview.blocked) {
    avisos.push(
      `<div class="box bad"><b>Falta: ${esc(preview.blocked.missing.join(', '))}.</b> ${esc(preview.blocked.message)}</div>`
    );
  }

  // ¿Ya se facturo a mano o por otra integracion?
  const chk = preview.existingCheck || { ok: true, candidates: [] };
  const seguros = chk.candidates.filter((x) => x.mentionsOrder);
  let revision = '';
  if (!yaTiene) {
    if (!chk.ok) {
      revision = `<div class="box bad">No se pudo revisar en Bsale si esta venta ya esta facturada (${esc(chk.error)}). Sin esa revision no se emite.</div>`;
    } else if (!chk.candidates.length) {
      revision = `<div class="box ok">No hay documentos en Bsale con el mismo monto o el mismo RUT desde unos dias antes de la venta hasta hoy.</div>
<p class="muted">Se busco por monto y RUT. Si la facturaste a mano con otro monto o sin RUT, no aparece aqui: revisalo tambien en Bsale y en el canal.</p>`;
    } else {
      revision = `<div class="box ${seguros.length ? 'bad' : 'warn'}">${
        seguros.length
          ? `<b>Parece ya facturada:</b> hay documentos que mencionan el pedido ${esc(id)}. No se emite.`
          : `Hay ${chk.candidates.length} documento(s) parecidos (mismo monto o RUT). Revisalos antes de emitir.`
      }</div>
<table><tr><th>Documento</th><th>Fecha</th><th>Monto</th><th>Menciona el pedido</th></tr>${chk.candidates
        .map(
          (x) =>
            `<tr><td>${esc(x.documentType || 'Documento')} N° ${esc(x.number)}${
              x.url ? ` · <a href="${esc(x.url)}" target="_blank" rel="noopener">ver</a>` : ''
            }</td><td>${esc(x.emissionDate)}</td><td>${clp(x.total)}</td><td>${x.mentionsOrder ? '<b>SI</b>' : 'no'}</td></tr>`
        )
        .join('')}</table>`;
    }
  }
  const pistas = Object.entries(preview.channelInvoiceHints || {});
  if (pistas.length) {
    revision += `<p class="muted">Datos de facturacion que trae el canal: ${pistas
      .map(([k, v]) => `<code>${esc(k)}</code>=${esc(v)}`)
      .join(' · ')}</p>`;
  }

  const puedeEmitir = !yaTiene && !preview.blocked && chk.ok && !seguros.length;
  const casilla = chk.candidates.length
    ? `<p><label><input type="checkbox" name="revisado" value="si" required> Revise esos documentos en Bsale y no son esta venta.</label></p>`
    : '';

  const form = !puedeEmitir
    ? ''
    : `<h2>Emitir</h2>
${avisoSii(declareSii)}
<form method="post" action="/panel/prueba/${encodeURIComponent(name)}/${encodeURIComponent(id)}/emitir">
  <input type="hidden" name="token" value="${esc(token)}">
  <input type="hidden" name="expectedKind" value="${esc(preview.docKind)}">
  <input type="hidden" name="expectedTotal" value="${esc(o.total)}">
  ${casilla}
  <p>Para emitir <b>esta ${esc(preview.docKind)} por ${clp(o.total)}</b>, escribe el numero de pedido <b>${esc(id)}</b>:</p>
  <p><input name="confirm" autocomplete="off" required> <button type="submit">Emitir este documento</button></p>
  <p class="muted">Si el pedido cambia entre esta vista y el clic (tipo o monto), no se emite.</p>
</form>`;

  const body = `${head}
${avisos.join('')}
<h2>Documento previsto</h2>
<table>
<tr><th>Tipo</th><td><b>${esc(preview.docKind)}</b>${preview.payload ? ` (tipo Bsale ${esc(preview.payload.documentTypeId)})` : ''}</td></tr>
<tr><th>Monto total</th><td class="total">${clp(o.total)}</td></tr>
<tr><th>Despacho</th><td>${clp(o.shippingCost)}</td></tr>
<tr><th>Fecha de la venta</th><td>${esc(new Date(o.createdAt).toLocaleString('es-CL'))}</td></tr>
<tr><th>Cliente</th><td>${esc(c.businessName || c.name)}${c.rut ? ` · RUT ${esc(c.rut)}` : ''}${c.activity ? ` · Giro ${esc(c.activity)}` : ''}</td></tr>
<tr><th>Referencia anti-duplicados</th><td><code>${esc(preview.payload?.salesId || '')}</code></td></tr>
<tr><th>Fecha de inicio del canal</th><td>${preview.startAt ? esc(preview.startAt) : 'sin fecha (el canal no factura solo)'}</td></tr>
</table>
<h2>Detalle</h2>
<table><tr><th>Cant.</th><th>Producto</th><th>Precio bruto</th><th>Subtotal</th></tr>${items}</table>
<h2>¿Ya esta facturada?</h2>
${revision || '<p class="muted">No aplica.</p>'}
${form}
${back}`;
  return page('Prueba controlada', body);
}

export function renderResultPage({ token, name, id, result, error }) {
  const back = `<p class="muted"><a href="/panel?token=${encodeURIComponent(token)}">Volver al panel</a></p>`;
  const head = `<h1>Prueba controlada · ${esc(name)} #${esc(id)}</h1>`;
  if (error) return page('Resultado', `${head}<div class="box bad">${esc(error)}</div>${back}`);

  const doc = result?.document;
  if (result?.status === 'done' && doc) {
    return page(
      'Resultado',
      `${head}<div class="box ok">Emitida ${esc(doc.docKind)} N° ${esc(doc.number)}${
        doc.url ? ` · <a href="${esc(doc.url)}" target="_blank" rel="noopener">ver documento</a>` : ''
      }</div>${back}`
    );
  }
  return page(
    'Resultado',
    `${head}<div class="box warn">Estado: <b>${esc(result?.status)}</b>${
      result?.error || result?.reason ? ` · ${esc(result.error || result.reason)}` : ''
    }</div><p class="muted">Revisa el panel. Si quedo en reintento, el conector reintenta con la misma referencia anti-duplicados.</p>${back}`
  );
}
