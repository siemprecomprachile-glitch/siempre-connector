// Paris (Cencosud) - E-commerce API connector
// Converts marketplace orders to Bsale invoice payloads

import axios from 'axios';
import { db } from '../db.js';
import { buildDocumentPayload } from '../bsale/documents.js';

const PARIS_API_BASE = process.env.PARIS_API_BASE || 'https://api.paris.cl/v1';
const PARIS_API_TOKEN = process.env.PARIS_API_TOKEN;

export async function fetchParisOrders() {
  try {
    const response = await axios.get(\`\${PARIS_API_BASE}/orders\`, {
      headers: { Authorization: \`Bearer \${PARIS_API_TOKEN}\` }
    });
    return response.data || [];
  } catch (error) {
    console.error('Paris API error:', error.message);
    return [];
  }
}

export async function processParisOrder(order) {
  const payload = await buildDocumentPayload({
    channel: 'paris',
    externalId: order.id,
    customer: { email: order.customer_email, rut: order.customer_rut },
    items: order.line_items.map(item => ({
      productCode: item.sku,
      quantity: item.quantity,
      unitPrice: item.price,
      description: item.name
    })),
    total: order.total
  });
  
  return payload;
}
