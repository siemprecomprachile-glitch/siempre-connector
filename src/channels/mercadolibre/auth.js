import { config } from '../../config.js';
import { tokens } from '../../db.js';
import { log } from '../../logger.js';

const CHANNEL = 'mercadolibre';
const ML = config.mercadolibre;

/** URL a la que entra el usuario una sola vez para autorizar la app. */
export function authorizationUrl(state = 'siempre') {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: ML.clientId,
    redirect_uri: ML.redirectUri,
    state,
  });
  return `https://auth.mercadolibre.cl/authorization?${params}`;
}

async function exchange(body) {
  const res = await fetch(`${ML.apiUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `OAuth Mercado Libre ${res.status}: ${data.message || data.error || 'error desconocido'}`
    );
  }

  tokens.save(CHANNEL, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    // 60s de margen para no usar un token que expira en el camino.
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    meta: { userId: data.user_id, scope: data.scope },
  });

  log.info('ml.token_saved', { userId: data.user_id });
  return data;
}

/** Primer intercambio: el ?code= que llega al callback. */
export function exchangeCode(code) {
  return exchange({
    grant_type: 'authorization_code',
    client_id: ML.clientId,
    client_secret: ML.clientSecret,
    code,
    redirect_uri: ML.redirectUri,
  });
}

/**
 * Devuelve un access_token valido, refrescando solo si hace falta.
 * El refresh_token de ML dura 6 meses y se rota en cada uso: hay que guardarlo.
 */
export async function getAccessToken() {
  const row = tokens.get(CHANNEL);
  if (!row) {
    const err = new Error(
      'Mercado Libre no esta conectado todavia. Entra a /oauth/mercadolibre para autorizar.'
    );
    err.permanent = true;
    err.code = 'ML_NOT_CONNECTED';
    throw err;
  }

  if (row.expires_at && row.expires_at > Date.now()) return row.access_token;

  if (!row.refresh_token) {
    const err = new Error('El token de Mercado Libre expiro y no hay refresh_token. Reautoriza.');
    err.permanent = true;
    throw err;
  }

  log.info('ml.refreshing_token');
  const data = await exchange({
    grant_type: 'refresh_token',
    client_id: ML.clientId,
    client_secret: ML.clientSecret,
    refresh_token: row.refresh_token,
  });
  return data.access_token;
}

export function isConnected() {
  return Boolean(tokens.get(CHANNEL));
}

export function connectionInfo() {
  const row = tokens.get(CHANNEL);
  if (!row) return { connected: false };
  return {
    connected: true,
    userId: row.meta ? JSON.parse(row.meta).userId : null,
    expiresAt: row.expires_at,
    expired: row.expires_at ? row.expires_at <= Date.now() : false,
  };
}
