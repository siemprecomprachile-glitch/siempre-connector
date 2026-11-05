# siempre-connector

Conector multi-canal (Mercado Libre, Paris, Lider, Falabella, Shopify) hacia Bsale
para emitir boletas y facturas automaticamente.

## Seguridad antes de encender un canal

- `<CANAL>_ENABLED=true` enciende el barrido de ese canal. Sin `<CANAL>_START_AT`
  (fecha ISO, p. ej. `2026-11-10T00:00:00-03:00`) el canal **no factura nada
  automatico**. Las ventas anteriores a esa fecha nunca se facturan solas.
- Cada emision lleva `salesId = siempre:<canal>:<pedido>`: si un reintento
  repite la emision, Bsale devuelve el documento existente (mismo tipo).
- Notas de credito: `AUTO_CREDIT_NOTES=false` por defecto. Una devolucion queda
  en el panel esperando aprobacion; antes de emitir se consulta si Bsale ya
  tiene una devolucion para ese documento.
- `BSALE_DECLARE_SII=0` **no es una simulacion**: el documento se crea en Bsale
  (con numero, y descuenta stock si el SKU existe). Solo no se envia al SII.
- `salesId` no detecta documentos hechos a mano o por otra integracion (Pivot).
  La prueba controlada busca en Bsale documentos con el mismo monto o RUT: si
  alguno menciona el pedido no deja emitir; si hay parecidos, exige revisarlos.
- RUT de empresa sin razon social o giro: la factura queda bloqueada
  ("Falta dato para la factura") hasta completar el dato. Nunca cambia a boleta.
- Falabella y Shopify siguen con Pivot: quedan apagados en este conector.

## Endpoints de prueba (todos piden `?token=ADMIN_TOKEN`)

| Ruta | Que hace | Emite? |
|---|---|---|
| `GET /health` | Estado, canales, fecha de inicio, almacenamiento (`storage`) | No (sin token) |
| `GET /panel/canales/<canal>/probar` | Prueba credenciales y lista pedidos recientes. `<canal>`: `paris`, `lider`, `mercadolibre`, `falabella` | No |
| `GET /panel/canales/<canal>/pedido/<id>` | JSON con el documento que se emitiria | No |
| `GET /panel/prueba/<canal>/<id>` | Pagina con tipo, monto, items y cliente previstos | No |
| `POST /panel/prueba/<canal>/<id>/emitir` | Emite ESE pedido. Exige escribir el numero de pedido y que tipo y monto no hayan cambiado | **Si** |
| `GET/POST /panel/bsale/prueba-salesid` | Valida salesId en la empresa de PRUEBAS (`BSALE_TEST_ACCESS_TOKEN`) | Solo en la empresa de pruebas |

Lo mismo por consola, sin servidor: `node scripts/bsale-prueba-salesid.js` con
`BSALE_TEST_ACCESS_TOKEN` definido.

## Lider (Walmart Chile)

Host `https://marketplace.walmartapis.com` con `WM_MARKET=cl` y
`WM_GLOBAL_VERSION=3.1`. Token: `POST /v3/token` (Basic ClientID:ClientSecret,
15 min). Se factura cuando todas las lineas activas estan Acknowledged, Shipped o
Delivered; Created espera y las canceladas no se facturan.

## Pruebas

`npm test` (sin red: Bsale, Paris y Walmart simulados).
