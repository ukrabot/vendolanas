# Packs digitales: configuración en Cloudflare

El sitio sigue siendo estático. El archivo `worker/index.js` agrega la parte de servidor
para cobrar con Mercado Pago y Flow, entregar las descargas y alimentar el panel `/admin/`.

## 1. Base de datos D1
Cloudflare → Storage & Databases → D1 → **Create database** → nombre `vendolanas-db`.
Copia el **Database ID** y pégalo en `wrangler.jsonc` en lugar de `REEMPLAZAR_CON_EL_ID_DE_D1`.
Las tablas se crean solas la primera vez que alguien usa la API.

## 2. Secrets del Worker
Cloudflare → Workers & Pages → (tu Worker) → Settings → Variables and Secrets → **Add** → tipo *Secret*:

| Nombre | Valor |
|---|---|
| `MP_ACCESS_TOKEN` | Access Token de Mercado Pago (producción: empieza con `APP_USR-`; pruebas: `TEST-`) |
| `FLOW_API_KEY` | API Key de Flow |
| `FLOW_SECRET_KEY` | Secret Key de Flow |
| `ADMIN_PASSWORD` | Contraseña larga para entrar a `/admin/` |
| `MP_WEBHOOK_SECRET` | (opcional) Clave secreta de webhooks de Mercado Pago |
| `RESEND_API_KEY` | (opcional) Para enviar el enlace por correo; además completa `EMAIL_FROM` en `wrangler.jsonc` |

La Public Key de Mercado Pago no se necesita: el pago se hace en la página de Mercado Pago (Checkout Pro).
Para probar Flow en sandbox cambia `FLOW_API_URL` a `https://sandbox.flow.cl/api` y usa las credenciales de sandbox.

## 3. Subir el PDF
El repositorio es público, por eso los PDF **no** se guardan aquí. Entra a `https://vendolanas.cl/admin/`
→ pestaña **Packs** → elige el PDF → **Subir PDF**. El pack solo se puede comprar cuando tiene su PDF.

## Direcciones que usan los medios de pago
- Mercado Pago (aviso de pago): `https://vendolanas.cl/api/webhooks/mercadopago` (se envía sola en cada pago).
- Flow (confirmación): `https://vendolanas.cl/api/webhooks/flow` (se envía sola en cada pago).
