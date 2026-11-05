/**
 * Validacion de `salesId` contra la EMPRESA DE PRUEBAS de Bsale.
 *
 * Usa SOLO el token que recibe (BSALE_TEST_ACCESS_TOKEN, el de la empresa de
 * pruebas de account.bsale.dev). No importa config.js ni lee .env: nunca toca el
 * token real. El token es el que define la empresa en Bsale.
 * Crea boletas (y una factura, si la empresa la tiene) con declareSii=0.
 *
 * Protecciones para no tocar la empresa real:
 *  - Si el token es igual a BSALE_ACCESS_TOKEN, no corre.
 *  - Si la empresa tiene mas de `maxExistingDocs` documentos, no corre (una
 *    empresa de pruebas tiene pocos; la real, miles).
 *  - Antes de crear nada muestra sucursales y tipos y pide confirmacion.
 *
 * Responde cuatro preguntas:
 *  A. Mismo salesId y mismo tipo dos veces -> ¿Bsale devuelve el mismo documento?
 *  B. Peticion cortada por timeout y reintento -> ¿queda un solo documento?
 *  C. Mismo salesId pero factura en vez de boleta (se perdio el tipo guardado)
 *     -> ¿Bsale crea un segundo documento?
 *  D. ¿GET /documents/{id}.json devuelve salesId? (si no, no se puede buscar por el)
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSalesIdSelfTest({
  token,
  realToken,
  apiUrl = 'https://api.bsale.io/v1',
  timeouts = [200, 700, 1500, 3000],
  pauseMs = 5000,
  maxExistingDocs = 300,
  fetchImpl = globalThis.fetch,
  log = () => {},
  confirm = async () => true,
} = {}) {
  if (!token) throw new Error('Falta BSALE_TEST_ACCESS_TOKEN (token de la empresa de PRUEBAS).');
  if (realToken && token === realToken) {
    throw new Error('BSALE_TEST_ACCESS_TOKEN es igual a BSALE_ACCESS_TOKEN (el real). No se ejecuta.');
  }
  const base = String(apiUrl || 'https://api.bsale.io/v1').replace(/\/$/, '');

  async function req(method, path, body, { timeoutMs = 20000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { access_token: token, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      if (!res.ok) {
        const err = new Error(`Bsale ${res.status}: ${data?.error || data?.message || text}`);
        err.status = res.status;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  const out = { startedAt: new Date().toISOString(), apiUrl: base, steps: [], documents: [] };
  const step = (name, pass, detail) => {
    out.steps.push({ name, pass, detail });
    log(`${pass === true ? 'OK ' : pass === false ? 'FALLA' : 'INFO'} ${name}: ${JSON.stringify(detail)}`);
  };

  // --- cuenta -----------------------------------------------------------------
  const tipos = (await req('GET', '/document_types.json?limit=50'))?.items || [];
  const boleta = tipos.find((d) => Number(d.codeSii) === 39);
  const factura = tipos.find((d) => Number(d.codeSii) === 33);
  if (!boleta) throw new Error('La empresa no tiene boleta electronica (codigo SII 39).');
  const offices = (await req('GET', '/offices.json?limit=50'))?.items || [];
  const office = offices.find((o) => Number(o.state) === 0) || offices[0];
  if (!office) throw new Error('La empresa no tiene sucursales.');
  const taxes = (await req('GET', '/taxes.json?limit=50'))?.items || [];
  const iva = taxes.find((t) => Number(t.percentage) === 19) || taxes[0];
  if (!iva) throw new Error('La empresa no tiene impuestos configurados.');

  const total = await req('GET', '/documents.json?limit=1');
  const existentes = Number(total?.count ?? (total?.items || []).length);
  out.account = {
    offices: offices.map((o) => ({ id: o.id, name: o.name, address: o.address ?? null })),
    officeId: office.id,
    officeName: office.name,
    boletaTypeId: boleta.id,
    facturaTypeId: factura?.id ?? null,
    taxId: iva.id,
    documentosExistentes: existentes,
  };
  if (existentes > maxExistingDocs) {
    throw new Error(
      `La empresa de este token ya tiene ${existentes} documentos: parece una empresa REAL, no la de pruebas. No se ejecuta.`
    );
  }
  if (!(await confirm(out.account))) {
    out.cancelled = true;
    return out;
  }

  const emission = Math.floor(Date.now() / 1000);
  const run = Date.now().toString(36);
  // Monto al azar: sirve para contar en Bsale cuantos documentos quedaron
  // (el GET no filtra por salesId, pero si por monto total).
  const montoUnico = () => 1000 + Math.floor(Math.random() * 98000);
  const payload = (documentTypeId, salesId, bruto, client) => ({
    documentTypeId,
    officeId: office.id,
    emissionDate: emission,
    expirationDate: emission,
    declareSii: 0,
    salesId,
    client: client || { firstName: 'Prueba', lastName: 'Conector' },
    details: [
      {
        quantity: 1,
        netUnitValue: Number((bruto / 1.19).toFixed(4)),
        taxId: `[${iva.id}]`,
        comment: `Prueba salesId ${salesId}`,
      },
    ],
  });
  const guardar = (doc, nota) => {
    if (doc?.id) out.documents.push({ id: doc.id, number: doc.number ?? null, total: doc.totalAmount ?? null, nota });
  };
  const listar = async (documentTypeId, total) =>
    ((await req('GET', `/documents.json?documenttypeid=${documentTypeId}&totalamount=${total}&limit=50`))?.items || [])
      .map((d) => d.id);
  const contar = async (documentTypeId, total) => (await listar(documentTypeId, total)).length;
  const totalDe = (bruto) => Math.round(Number((bruto / 1.19).toFixed(4)) * 1.19);

  // --- A: mismo salesId, mismo tipo --------------------------------------------
  const sidA = `prueba-${run}-a`;
  const brutoA = montoUnico();
  const a1 = await req('POST', '/documents.json', payload(boleta.id, sidA, brutoA));
  guardar(a1, 'A: primer envio');
  const a2 = await req('POST', '/documents.json', payload(boleta.id, sidA, brutoA));
  const nA = await contar(boleta.id, a1.totalAmount);
  step('A. mismo salesId y mismo tipo devuelve el mismo documento', a1.id === a2.id && nA === 1, {
    primerId: a1.id,
    segundoId: a2.id,
    documentosConEseMonto: nA,
  });

  // --- B: timeout y reintento -------------------------------------------------
  // Se corta la peticion a los `ms` milisegundos (como un timeout real), se
  // espera y se mira si Bsale alcanzo a crear el documento. El caso que prueba
  // de verdad salesId es: cortada + Bsale ya lo tenia + el reintento devuelve
  // ESE mismo documento.
  for (const ms of timeouts) {
    const sid = `prueba-${run}-b${ms}`;
    const bruto = montoUnico();
    let cortado = false;
    let primero = null;
    try {
      primero = await req('POST', '/documents.json', payload(boleta.id, sid, bruto), { timeoutMs: ms });
      guardar(primero, `B${ms}: la respuesta alcanzo a llegar`);
    } catch (err) {
      cortado = true;
    }
    await sleep(pauseMs);
    const antes = await listar(boleta.id, primero?.totalAmount ?? totalDe(bruto));
    const d2 = await req('POST', '/documents.json', payload(boleta.id, sid, bruto));
    guardar(d2, `B${ms}: reintento`);
    const despues = await listar(boleta.id, d2.totalAmount);
    const bsaleLoTenia = antes.length === 1;
    step(`B. corte a los ${ms} ms y reintento deja un solo documento`, despues.length === 1 && (!bsaleLoTenia || antes[0] === d2.id), {
      primerEnvioCortado: cortado,
      bsaleLoCreoAunqueSeCorto: cortado && bsaleLoTenia,
      documentosAntesDelReintento: antes.length,
      documentosDespues: despues.length,
      reintentoDevolvioElMismo: bsaleLoTenia ? antes[0] === d2.id : null,
      idFinal: d2.id,
    });
  }

  // --- C: cambio de tipo con el mismo salesId ----------------------------------
  if (factura) {
    try {
      const c = await req(
        'POST',
        '/documents.json',
        payload(factura.id, sidA, brutoA, {
          code: '76086428-5',
          company: 'Empresa de Prueba SpA',
          activity: 'Comercio',
          address: 'Calle Prueba 123',
          municipality: 'Santiago',
          city: 'Santiago',
        })
      );
      guardar(c, 'C: factura con el salesId de A');
      step('C. mismo salesId en factura (tipo perdido)', null, {
        resultado:
          c.id === a1.id
            ? 'Bsale devolvio la boleta original (protege entre tipos)'
            : 'Bsale creo un documento NUEVO: salesId protege solo dentro del mismo tipo',
        boletaId: a1.id,
        facturaId: c.id,
      });
    } catch (err) {
      step('C. mismo salesId en factura (tipo perdido)', null, { rechazado: err.message });
    }
  } else {
    step('C. mismo salesId en factura (tipo perdido)', null, { omitido: 'la empresa no tiene factura (SII 33)' });
  }

  // --- D: ¿GET devuelve salesId? -----------------------------------------------
  const got = await req('GET', `/documents/${a1.id}.json`);
  step('D. GET del documento devuelve salesId', null, {
    trae: Object.prototype.hasOwnProperty.call(got || {}, 'salesId'),
    valor: got?.salesId ?? null,
  });

  const pasosB = out.steps.filter((s) => s.name.startsWith('B.'));
  const pasoC = out.steps.find((s) => s.name.startsWith('C.'));
  out.resumen = {
    mismoPedidoMismoTipoDevuelveElMismo: out.steps.find((s) => s.name.startsWith('A.'))?.pass === true,
    reintentosTrasCorteSinDuplicar: pasosB.every((s) => s.pass === true),
    // Solo cuenta como probado si en algun corte Bsale alcanzo a crear el
    // documento y el reintento devolvio ese mismo.
    timeoutProbadoDeVerdad: pasosB.some((s) => s.pass === true && s.detail.bsaleLoCreoAunqueSeCorto),
    siCambiaElTipo: pasoC?.detail?.resultado || pasoC?.detail?.rechazado || pasoC?.detail?.omitido || null,
    getDevuelveSalesId: out.steps.find((s) => s.name.startsWith('D.'))?.detail?.trae ?? null,
  };
  out.finishedAt = new Date().toISOString();
  out.allPassed = out.steps.every((s) => s.pass !== false);
  return out;
}
