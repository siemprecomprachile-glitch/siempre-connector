/**
 * Utilidades de RUT chileno.
 * Bsale espera el RUT en formato "12345678-9" (sin puntos, con guion).
 */

export function cleanRut(value) {
  if (!value) return '';
  return String(value).replace(/[^0-9kK]/g, '').toUpperCase();
}

export function computeDv(body) {
  let sum = 0;
  let multiplier = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  const rest = 11 - (sum % 11);
  if (rest === 11) return '0';
  if (rest === 10) return 'K';
  return String(rest);
}

export function isValidRut(value) {
  const clean = cleanRut(value);
  if (clean.length < 7 || clean.length > 9) return false;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  if (!/^\d+$/.test(body)) return false;
  return computeDv(body) === dv;
}

/** Devuelve "12345678-9" o null si el RUT no es valido. */
export function formatRut(value) {
  const clean = cleanRut(value);
  if (!isValidRut(clean)) return null;
  return `${clean.slice(0, -1)}-${clean.slice(-1)}`;
}

/**
 * En Chile los RUT de empresa parten sobre 50.000.000 (aprox).
 * Es una heuristica: el criterio duro para facturar es que el comprador
 * haya entregado razon social y giro.
 */
export function looksLikeCompany(rut) {
  const clean = cleanRut(rut);
  if (!clean) return false;
  const body = Number(clean.slice(0, -1));
  return Number.isFinite(body) && body >= 50000000;
}
