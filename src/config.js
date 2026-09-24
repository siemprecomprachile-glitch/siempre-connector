import fs from 'node:fs';
import path from 'node:path';

// Carga .env sin dependencias externas.
function loadEnvFile() {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile();

const bool = (v, fallback = false) => {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'si', 'sí'].includes(String(v).toLowerCase());
};
const int = (v, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 3000),
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${int(process.env.PORT, 3000)}`).replace(/\/$/, ''),
  adminToken: process.env.ADMIN_TOKEN || '',
  dataDir: process.env.DATA_DIR || './data',

  bsale: {
    token: process.env.BSALE_ACCESS_TOKEN || '',
    apiUrl: (process.env.BSALE_API_URL || 'https://api.bsale.io/v1').replace(/\/$/, ''),
    officeId: int(process.env.BSALE_OFFICE_ID, 1),
    boletaTypeId: int(process.env.BSALE_DOCTYPE_BOLETA_ID, 0),
    facturaTypeId: int(process.env.BSALE_DOCTYPE_FACTURA_ID, 0),
    notaCreditoTypeId: int(process.env.BSALE_DOCTYPE_NOTA_CREDITO_ID, 0),
    paymentTypeId: int(process.env.BSALE_PAYMENT_TYPE_ID, 0),
    declareSii: bool(process.env.BSALE_DECLARE_SII, false) ? 1 : 0,
    taxId: int(process.env.BSALE_TAX_ID, 1),
  },

  mercadolibre: {
    clientId: process.env.ML_CLIENT_ID || '',
    clientSecret: process.env.ML_CLIENT_SECRET || '',
    sellerId: process.env.ML_SELLER_ID || '',
    apiUrl: 'https://api.mercadolibre.com',
    get redirectUri() {
      return `${config.publicUrl}/oauth/mercadolibre/callback`;
    },
    get enabled() {
      return Boolean(process.env.ML_CLIENT_ID && process.env.ML_CLIENT_SECRET);
    },
  },

  shopify: {
    enabled: bool(process.env.SHOPIFY_ENABLED, false),
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN || '',
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || '',
  },

  falabella: {
    enabled: bool(process.env.FALABELLA_ENABLED, false),
    userId: process.env.FALABELLA_USER_ID || '',
    apiKey: process.env.FALABELLA_API_KEY || '',
    apiUrl: 'https://sellercenter-api.falabella.com',
  },

  paris: {
    enabled: bool(process.env.PARIS_ENABLED, false),
    sellerId: process.env.PARIS_SELLER_ID || '',
    apiKey: process.env.PARIS_API_KEY || '',
    // Produccion: api-developers.ecomm.cencosud.com
    // Pruebas:    api-developers.ecomm-stg.cencosud.com
    apiUrl: (process.env.PARIS_API_URL || 'https://api-developers.ecomm.cencosud.com').replace(
      /\/$/,
      ''
    ),
    // De que campo del item sale el precio bruto de venta.
    priceField: process.env.PARIS_PRICE_FIELD || 'basePrice',
    // Subir el PDF del documento a Paris (dispara el envio al comprador).
    uploadInvoice: bool(process.env.PARIS_UPLOAD_INVOICE, true),
  },

  lider: {
    enabled: bool(process.env.LIDER_ENABLED, false),
    clientId: process.env.LIDER_CLIENT_ID || '',
    clientSecret: process.env.LIDER_CLIENT_SECRET || '',
    apiUrl: (process.env.LIDER_API_URL || 'https://marketplace.walmartapis.com').replace(/\/$/, ''),
  },

  rules: {
    autoFacturaOnRut: bool(process.env.AUTO_FACTURA_ON_RUT, true),
    billingDelayMinutes: int(process.env.BILLING_DELAY_MINUTES, 0),
    requirePaid: bool(process.env.REQUIRE_PAID, true),
    // Para Paris, Lider y Falabella este barrido no es red de seguridad:
    // es la unica forma de enterarse de una venta. Por eso va seguido.
    sweepIntervalMinutes: int(process.env.SWEEP_INTERVAL_MINUTES, 10),
  },
};

export function assertConfig() {
  const missing = [];
  if (!config.bsale.token) missing.push('BSALE_ACCESS_TOKEN');
  if (!config.bsale.boletaTypeId) missing.push('BSALE_DOCTYPE_BOLETA_ID');
  if (!config.adminToken) missing.push('ADMIN_TOKEN');
  return missing;
}
