// Lider (Walmart) - E-commerce API connector
// Converts marketplace orders to Bsale invoice payloads

import axios from 'axios';
import { db } from '../db.js';
import { buildDocumentPayload } from '../bsale/documents.js';

const LIDER_API_BASE = 'https://marketplace-api.walmart.com.br/v2';
const LIDER_CLIENT_ID = process.env.LIDER_CLIENT_ID;
const LIDER_CLIENT_SECRET = process.env.LIDER_CLIENT_SECRET;

let liderAccessToken = null;
let tokenExpiry = null;

export async function getLiderAccessToken() {
  if (liderAccessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return liderAccessToken;
  }
  
  try {
    const response = await axios.post(\`\${LIDER_API_BASE}/token\`, {
      client_id: LIDER_CLIENT_ID,
      client_secret: LIDER_CLIENT_SECRET,
      grant_type: 'client_credentials'
    });
    
    liderAccessToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in * 1000);
    return liderAccessToken;
  } catch (error) {
    console.error('Lider token error:', error.message);
    throw error;
  }
}

export async function fetchLiderOrders() {
  try {
    const token = await getLiderAccessToken();
    const response = await axios.get(\`\${LIDER_API_BASE}/orders\`, {
      headers: { Authorization: \`Bearer \${token}\` }
    });
    return response.data.orders || [];
  } catch (error) {
    console.error('Lider API error:', error.message);
    return [];
  }
}

export async function processLiderOrder(order) {
  const payload = await buildDocumentPayload({
    channel: 'lider',
    externalId: order.orderId,
    customer: { email: order.customer.email, rut: order.customer.document },
    items: order.items.map(item => ({
      productCode: item.sku,
      quantity: item.quantity,
      unitPrice: item.price,
      description: item.title
    })),
    total: order.totalAmount
  });
  
  return payload;
}
