/**
 * VendoLanas.cl — Worker de Cloudflare
 *
 * Sirve el sitio estático (binding ASSETS) y agrega una pequeña API para vender
 * packs digitales con Mercado Pago (Checkout Pro) y Flow, entregar las descargas
 * de forma protegida y alimentar el panel de administración.
 *
 * Los PDF de los packs NO están en el repositorio (es público): se suben desde
 * /admin/ → Packs y quedan guardados en la base de datos D1.
 *
 * Secrets (Cloudflare → Worker → Settings → Variables and Secrets):
 *   MP_ACCESS_TOKEN      Access Token de Mercado Pago
 *   FLOW_API_KEY         API Key de Flow
 *   FLOW_SECRET_KEY      Secret Key de Flow
 *   ADMIN_PASSWORD       Contraseña del panel /admin/
 *   MP_WEBHOOK_SECRET    (opcional) clave secreta de webhooks de Mercado Pago
 *   RESEND_API_KEY       (opcional) para enviar el enlace por correo
 * Variables (wrangler.jsonc → vars):
 *   FLOW_API_URL, MP_API_URL, EMAIL_FROM
 */

const MAX_DESCARGAS = 15;
const TROZO_BYTES = 500000;           // tamaño de cada parte del PDF en D1
const MAX_ARCHIVO_BYTES = 20000000;   // 20 MB por pack
const DIAS_VIGENCIA = 60;
const SESION_HORAS = 12;

// Ajustes editables desde el panel (mensaje emergente de los artículos).
const AJUSTES_INICIALES = { popup_activo: 1, popup_segundos: 20 };

// Packs iniciales. El panel admin puede cambiar título, precio y estado.
const PACKS_INICIALES = [
  {
    slug: 'pack-aros-a-crochet',
    titulo: 'Pack digital: Aros a crochet',
    descripcion: '12 diseños de aros paso a paso, guía de armado, paletas de color, calculadora de costos y tarjetas imprimibles. PDF de descarga inmediata.',
    precio: 3990,
    archivo: 'pack-aros-a-crochet.pdf',
    pagina: '/packs/pack-aros-a-crochet.html',
  },
  {
    slug: 'pack-cortinas-a-crochet',
    titulo: 'Pack digital: Cortinas a crochet',
    descripcion: '9 diseños de cortinas con gráficos de filet, calculadora de medidas y de hilo, guía para colgar y lavar, y planificador imprimible. PDF de descarga inmediata.',
    precio: 3990,
    archivo: 'pack-cortinas-a-crochet.pdf',
    pagina: '/packs/pack-cortinas-a-crochet.html',
  },
  {
    slug: 'pack-cuanta-lana-necesito',
    titulo: 'Pack digital: Cuánta lana necesito',
    descripcion: 'Tablas de lana por proyecto y talla, conversión de metros a ovillos para cada línea, factores por punto y planillas imprimibles. PDF de descarga inmediata.',
    precio: 3990,
    archivo: 'pack-cuanta-lana-necesito.pdf',
    pagina: '/packs/pack-cuanta-lana-necesito.html',
  },
  {
    slug: 'pack-caminos-de-mesa-a-crochet',
    titulo: 'Pack digital: Caminos de mesa a crochet',
    descripcion: '8 diseños de caminos de mesa con 3 gráficos de filet, medidas para cada mesa, hilo y costo por tamaño, bordes, flecos y planificador. PDF de descarga inmediata.',
    precio: 3990,
    archivo: 'pack-caminos-de-mesa-a-crochet.pdf',
    pagina: '/packs/pack-caminos-de-mesa-a-crochet.html',
  },
  {
    slug: 'pack-chales-a-crochet',
    titulo: 'Pack digital: Chales a crochet',
    descripcion: '6 diseños de chales (triangular, semicircular y estola), tabla de puntos por vuelta, hilo y costo por tamaño, bordes, flecos y bloqueo. PDF de descarga inmediata.',
    precio: 3990,
    archivo: 'pack-chales-a-crochet.pdf',
    pagina: '/packs/pack-chales-a-crochet.html',
  },
];

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const enc = new TextEncoder();

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      ...extra,
    },
  });
}

function error(mensaje, status = 400) {
  return json({ error: mensaje }, status);
}

function redirigir(url) {
  return new Response(null, { status: 303, headers: { Location: url, 'Cache-Control': 'no-store' } });
}

function aleatorioHex(bytes = 16) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function nuevoIdPedido() {
  const r = crypto.getRandomValues(new Uint8Array(3));
  const sufijo = [...r].map((b) => (b % 36).toString(36)).join('');
  return ('VL' + Date.now().toString(36) + sufijo).toUpperCase();
}

async function hmacHex(clave, mensaje) {
  const key = await crypto.subtle.importKey('raw', enc.encode(clave), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const firma = await crypto.subtle.sign('HMAC', key, enc.encode(mensaje));
  return [...new Uint8Array(firma)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(texto) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(texto)));
}

// Comparación en tiempo constante (compara los hash para igualar el largo).
async function igualesSeguro(a, b) {
  const [ha, hb] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(ha, hb);
  let d = 0;
  for (let i = 0; i < ha.length; i++) d |= ha[i] ^ hb[i];
  return d === 0;
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ahoraISO() {
  return new Date().toISOString();
}

function sumarDias(dias) {
  return new Date(Date.now() + dias * 86400000).toISOString();
}

function emailValido(e) {
  return typeof e === 'string' && e.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

async function leerJSON(request) {
  const tipo = request.headers.get('Content-Type') || '';
  if (!tipo.includes('application/json')) return null;
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Base de datos (D1). Las tablas se crean solas la primera vez.
// ---------------------------------------------------------------------------
let dbLista = false;

async function prepararDB(env) {
  if (dbLista) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS packs (
      slug TEXT PRIMARY KEY, titulo TEXT NOT NULL, descripcion TEXT, precio INTEGER NOT NULL,
      archivo TEXT NOT NULL, pagina TEXT, activo INTEGER NOT NULL DEFAULT 1, actualizado TEXT,
      archivo_bytes INTEGER NOT NULL DEFAULT 0, archivo_subido TEXT)`),
    // El PDF se guarda en trozos dentro de D1 (el repositorio de GitHub es público).
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pack_archivos (
      slug TEXT NOT NULL, parte INTEGER NOT NULL, datos BLOB NOT NULL, PRIMARY KEY (slug, parte))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pedidos (
      id TEXT PRIMARY KEY, clave TEXT NOT NULL, nombre TEXT, email TEXT NOT NULL, items TEXT NOT NULL,
      total INTEGER NOT NULL, metodo TEXT NOT NULL, estado TEXT NOT NULL, proveedor_ref TEXT, pago_ref TEXT,
      monto_pagado INTEGER, origen TEXT, creado TEXT NOT NULL, pagado_en TEXT, expira TEXT,
      descargas INTEGER NOT NULL DEFAULT 0, email_enviado INTEGER NOT NULL DEFAULT 0)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_pedidos_creado ON pedidos (creado)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS intentos_login (ip TEXT NOT NULL, ts INTEGER NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS ajustes (clave TEXT PRIMARY KEY, valor TEXT NOT NULL)'),
    ...Object.entries(AJUSTES_INICIALES).map(([k, v]) =>
      env.DB.prepare('INSERT OR IGNORE INTO ajustes (clave, valor) VALUES (?, ?)').bind(k, String(v))),
    ...PACKS_INICIALES.map((p) =>
      env.DB.prepare('INSERT OR IGNORE INTO packs (slug, titulo, descripcion, precio, archivo, pagina, activo, actualizado) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
        .bind(p.slug, p.titulo, p.descripcion, p.precio, p.archivo, p.pagina, ahoraISO())
    ),
  ]);
  dbLista = true;
}

async function obtenerPedido(env, id) {
  if (!id || typeof id !== 'string' || id.length > 40) return null;
  return env.DB.prepare('SELECT * FROM pedidos WHERE id = ?').bind(id).first();
}

async function pedidoConClave(env, id, clave) {
  const p = await obtenerPedido(env, id);
  if (!p || !clave || !(await igualesSeguro(p.clave, clave))) return null;
  return p;
}

// ---------------------------------------------------------------------------
// Mercado Pago (Checkout Pro)
// ---------------------------------------------------------------------------
function mpBase(env) {
  return env.MP_API_URL || 'https://api.mercadopago.com';
}

async function mpCrearPreferencia(env, pedido, items, origen) {
  const retorno = `${origen}/api/retorno/mp?pedido=${pedido.id}&k=${pedido.clave}`;
  const cuerpo = {
    items: items.map((it) => ({ id: it.slug, title: it.titulo, quantity: 1, unit_price: it.precio, currency_id: 'CLP' })),
    payer: { email: pedido.email, name: pedido.nombre || undefined },
    external_reference: pedido.id,
    back_urls: { success: retorno, failure: retorno, pending: retorno },
    auto_return: 'approved',
    binary_mode: true,
    notification_url: `${origen}/api/webhooks/mercadopago`,
    statement_descriptor: 'VENDOLANAS',
  };
  const r = await fetch(`${mpBase(env)}/checkout/preferences`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': pedido.id,
    },
    body: JSON.stringify(cuerpo),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Mercado Pago respondió ${r.status}: ${data.message || 'error'}`);
  const pruebas = String(env.MP_ACCESS_TOKEN).startsWith('TEST-');
  return { url: (pruebas && data.sandbox_init_point) || data.init_point, ref: data.id };
}

async function mpObtenerPago(env, idPago) {
  const r = await fetch(`${mpBase(env)}/v1/payments/${encodeURIComponent(idPago)}`, {
    headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` },
  });
  if (!r.ok) throw new Error(`Mercado Pago (pago ${idPago}) respondió ${r.status}`);
  return r.json();
}

async function mpProcesarPago(env, idPago, ctx) {
  const pago = await mpObtenerPago(env, idPago);
  const id = pago.external_reference;
  if (!id) return null;
  if (pago.status === 'approved' && pago.currency_id === 'CLP') {
    return marcarPagado(env, id, Math.round(Number(pago.transaction_amount)), String(pago.id), ctx);
  }
  if (['rejected', 'cancelled', 'refunded', 'charged_back'].includes(pago.status)) {
    await marcarEstado(env, id, pago.status === 'refunded' || pago.status === 'charged_back' ? 'reembolsado' : 'rechazado', String(pago.id));
  }
  return obtenerPedido(env, id);
}

// Verifica la firma x-signature si se configuró MP_WEBHOOK_SECRET.
async function mpFirmaValida(env, request, dataId) {
  if (!env.MP_WEBHOOK_SECRET) return true;
  const firma = request.headers.get('x-signature') || '';
  const reqId = request.headers.get('x-request-id') || '';
  const partes = Object.fromEntries(firma.split(',').map((p) => p.trim().split('=')));
  if (!partes.ts || !partes.v1) return false;
  const idNorm = /^[a-z0-9]+$/i.test(dataId) ? String(dataId).toLowerCase() : dataId;
  let manifiesto = '';
  if (dataId) manifiesto += `id:${idNorm};`;
  if (reqId) manifiesto += `request-id:${reqId};`;
  manifiesto += `ts:${partes.ts};`;
  return igualesSeguro(await hmacHex(env.MP_WEBHOOK_SECRET, manifiesto), partes.v1);
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------
function flowBase(env) {
  return env.FLOW_API_URL || 'https://www.flow.cl/api';
}

async function flowFirmar(env, params) {
  const texto = Object.keys(params).sort().map((k) => k + params[k]).join('');
  return hmacHex(env.FLOW_SECRET_KEY, texto);
}

async function flowCrearPago(env, pedido, items, origen) {
  const asunto = items.length === 1 ? items[0].titulo : `Packs digitales VendoLanas (${items.length})`;
  const params = {
    apiKey: env.FLOW_API_KEY,
    commerceOrder: pedido.id,
    subject: asunto.slice(0, 100),
    currency: 'CLP',
    amount: String(pedido.total),
    email: pedido.email,
    paymentMethod: '9',
    urlConfirmation: `${origen}/api/webhooks/flow`,
    urlReturn: `${origen}/api/retorno/flow?pedido=${pedido.id}&k=${pedido.clave}`,
  };
  params.s = await flowFirmar(env, params);
  const r = await fetch(`${flowBase(env)}/payment/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.url || !data.token) throw new Error(`Flow respondió ${r.status}: ${data.message || 'error'}`);
  return { url: `${data.url}?token=${encodeURIComponent(data.token)}`, ref: data.token };
}

async function flowObtenerEstado(env, token) {
  const params = { apiKey: env.FLOW_API_KEY, token };
  params.s = await flowFirmar(env, params);
  const r = await fetch(`${flowBase(env)}/payment/getStatus?${new URLSearchParams(params)}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Flow getStatus respondió ${r.status}: ${data.message || 'error'}`);
  return data;
}

async function flowProcesarToken(env, token, ctx) {
  const st = await flowObtenerEstado(env, token);
  const id = st.commerceOrder;
  if (!id) return null;
  // status: 1 pendiente, 2 pagada, 3 rechazada, 4 anulada
  if (Number(st.status) === 2) return marcarPagado(env, id, Math.round(Number(st.amount)), String(st.flowOrder || token), ctx);
  if (Number(st.status) === 3 || Number(st.status) === 4) await marcarEstado(env, id, 'rechazado', String(st.flowOrder || token));
  return obtenerPedido(env, id);
}

// ---------------------------------------------------------------------------
// Estados de pedido, correo
// ---------------------------------------------------------------------------
async function marcarEstado(env, id, estado, pagoRef) {
  await env.DB.prepare("UPDATE pedidos SET estado = ?, pago_ref = COALESCE(?, pago_ref) WHERE id = ? AND estado IN ('pendiente', 'error', 'rechazado')")
    .bind(estado, pagoRef || null, id).run();
}

async function marcarPagado(env, id, monto, pagoRef, ctx) {
  const p = await obtenerPedido(env, id);
  if (!p) return null;
  if (p.estado === 'pagado') return p;
  if (monto !== p.total) {
    // Nunca entregar si el monto no calza con el pedido.
    await env.DB.prepare("UPDATE pedidos SET estado = 'revisar', monto_pagado = ?, pago_ref = ? WHERE id = ?").bind(monto, pagoRef, id).run();
    return obtenerPedido(env, id);
  }
  await env.DB.prepare("UPDATE pedidos SET estado = 'pagado', monto_pagado = ?, pago_ref = ?, pagado_en = ?, expira = ? WHERE id = ? AND estado != 'pagado'")
    .bind(monto, pagoRef, ahoraISO(), sumarDias(DIAS_VIGENCIA), id).run();
  const actualizado = await obtenerPedido(env, id);
  const envio = enviarCorreo(env, actualizado).catch((e) => console.log('correo', e.message));
  if (ctx) ctx.waitUntil(envio);
  else await envio;
  return actualizado;
}

function enlacePedido(p) {
  return `${p.origen}/packs/gracias?pedido=${p.id}&k=${p.clave}`;
}

async function enviarCorreo(env, p, forzar = false) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return false;
  if (p.email_enviado && !forzar) return false;
  const items = JSON.parse(p.items);
  const enlace = enlacePedido(p);
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#4a3b3f">
    <h2 style="color:#8f3a63">¡Gracias por tu compra en VendoLanas!</h2>
    <p>Hola ${escHtml(p.nombre || '')}, tu pago del pedido <strong>${escHtml(p.id)}</strong> fue confirmado.</p>
    <p>Compraste: ${items.map((i) => escHtml(i.titulo)).join(', ')}</p>
    <p><a href="${escHtml(enlace)}" style="display:inline-block;background:#a94773;color:#fff;padding:12px 20px;border-radius:24px;text-decoration:none">Descargar mi pack</a></p>
    <p style="font-size:13px">El enlace es personal y funciona por ${DIAS_VIGENCIA} días. Si tienes problemas, escríbenos por WhatsApp al +56 9 2813 3801.</p>
  </div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [p.email], subject: `Tu pack digital de VendoLanas (${p.id})`, html }),
  });
  if (!r.ok) throw new Error(`Resend respondió ${r.status}`);
  await env.DB.prepare('UPDATE pedidos SET email_enviado = 1 WHERE id = ?').bind(p.id).run();
  return true;
}

function pedidoPublico(p, packs) {
  const items = JSON.parse(p.items);
  const pagado = p.estado === 'pagado';
  return {
    id: p.id,
    estado: p.estado,
    total: p.total,
    metodo: p.metodo,
    expira: p.expira,
    items: items.map((i) => ({ slug: i.slug, titulo: i.titulo, precio: i.precio })),
    descargas: pagado
      ? items.filter((i) => packs[i.slug]).map((i) => ({ titulo: i.titulo, url: `/api/descarga/${p.id}/${i.slug}?k=${p.clave}` }))
      : [],
    descargas_restantes: Math.max(0, MAX_DESCARGAS - p.descargas),
  };
}

async function mapaPacks(env) {
  const { results } = await env.DB.prepare('SELECT * FROM packs').all();
  return Object.fromEntries(results.map((r) => [r.slug, r]));
}

// ---------------------------------------------------------------------------
// Rutas públicas
// ---------------------------------------------------------------------------
async function leerAjustes(env) {
  const { results } = await env.DB.prepare('SELECT clave, valor FROM ajustes').all();
  const a = { ...AJUSTES_INICIALES };
  for (const r of results) a[r.clave] = Number(r.valor);
  return { popup_activo: !!a.popup_activo, popup_segundos: a.popup_segundos };
}

async function apiConfig(env) {
  // Se cachea 1 minuto: un cambio en el panel se nota en los artículos en menos de un minuto.
  return json(await leerAjustes(env), 200, { 'Cache-Control': 'public, max-age=60' });
}

async function apiAdminGuardarAjustes(request, env) {
  const b = await leerJSON(request);
  if (!b) return error('Solicitud inválida.');
  const seg = Math.round(Number(b.popup_segundos));
  if (!Number.isFinite(seg) || seg < 5 || seg > 600) return error('El tiempo debe estar entre 5 y 600 segundos.');
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO ajustes (clave, valor) VALUES (?, ?)').bind('popup_segundos', String(seg)),
    env.DB.prepare('INSERT OR REPLACE INTO ajustes (clave, valor) VALUES (?, ?)').bind('popup_activo', b.popup_activo ? '1' : '0'),
  ]);
  return json(await leerAjustes(env));
}

async function apiPacks(env) {
  const { results } = await env.DB.prepare('SELECT slug, titulo, descripcion, precio, pagina FROM packs WHERE activo = 1 AND archivo_bytes > 0 ORDER BY titulo').all();
  return json({ packs: results });
}

async function apiCheckout(request, env) {
  const b = await leerJSON(request);
  if (!b) return error('Solicitud inválida.');
  const slugs = Array.isArray(b.items) ? [...new Set(b.items.map(String))] : [];
  if (slugs.length < 1 || slugs.length > 10) return error('Tu carrito está vacío.');
  const nombre = String(b.nombre || '').trim().slice(0, 80);
  const email = String(b.email || '').trim().toLowerCase();
  if (nombre.length < 2) return error('Escribe tu nombre.');
  if (!emailValido(email)) return error('Revisa tu correo electrónico.');
  const metodo = b.metodo === 'flow' ? 'flow' : b.metodo === 'mp' ? 'mp' : null;
  if (!metodo) return error('Elige un medio de pago.');
  if (metodo === 'mp' && !env.MP_ACCESS_TOKEN) return error('Mercado Pago no está disponible en este momento.', 503);
  if (metodo === 'flow' && !(env.FLOW_API_KEY && env.FLOW_SECRET_KEY)) return error('Flow no está disponible en este momento.', 503);

  const packs = await mapaPacks(env);
  const items = [];
  for (const s of slugs) {
    const p = packs[s];
    if (!p || !p.activo || !p.archivo_bytes) return error('Uno de los packs no está disponible en este momento. Actualiza tu carrito.');
    items.push({ slug: p.slug, titulo: p.titulo, precio: p.precio });
  }
  const total = items.reduce((a, i) => a + i.precio, 0);
  const origen = new URL(request.url).origin;
  const pedido = { id: nuevoIdPedido(), clave: aleatorioHex(16), nombre, email, total };
  await env.DB.prepare(
    "INSERT INTO pedidos (id, clave, nombre, email, items, total, metodo, estado, origen, creado) VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?)"
  ).bind(pedido.id, pedido.clave, nombre, email, JSON.stringify(items), total, metodo, origen, ahoraISO()).run();

  try {
    const r = metodo === 'mp' ? await mpCrearPreferencia(env, pedido, items, origen) : await flowCrearPago(env, pedido, items, origen);
    await env.DB.prepare('UPDATE pedidos SET proveedor_ref = ? WHERE id = ?').bind(r.ref, pedido.id).run();
    return json({ url: r.url, pedido: pedido.id });
  } catch (e) {
    console.log('checkout', e.message);
    await env.DB.prepare("UPDATE pedidos SET estado = 'error' WHERE id = ?").bind(pedido.id).run();
    return error('No pudimos conectar con el medio de pago. Inténtalo de nuevo en unos minutos.', 502);
  }
}

async function apiWebhookMP(request, env, ctx) {
  const url = new URL(request.url);
  const cuerpo = await request.json().catch(() => ({}));
  const tipo = url.searchParams.get('type') || url.searchParams.get('topic') || cuerpo.type || cuerpo.topic;
  const idPago = url.searchParams.get('data.id') || (cuerpo.data && cuerpo.data.id) || url.searchParams.get('id');
  if (tipo !== 'payment' || !idPago) return new Response('ok');
  if (!(await mpFirmaValida(env, request, String(idPago)))) return new Response('firma inválida', { status: 401 });
  try {
    await mpProcesarPago(env, String(idPago), ctx);
  } catch (e) {
    console.log('webhook mp', e.message);
    return new Response('reintentar', { status: 500 });
  }
  return new Response('ok');
}

async function apiRetornoMP(request, env, ctx) {
  const u = new URL(request.url);
  const id = u.searchParams.get('pedido');
  const k = u.searchParams.get('k');
  const idPago = u.searchParams.get('payment_id') || u.searchParams.get('collection_id');
  const p = await pedidoConClave(env, id, k);
  if (!p) return redirigir('/packs/carrito');
  if (idPago && idPago !== 'null' && p.estado !== 'pagado') {
    try {
      const pago = await mpObtenerPago(env, idPago);
      if (pago.external_reference === p.id) await mpProcesarPago(env, idPago, ctx);
    } catch (e) {
      console.log('retorno mp', e.message);
    }
  }
  return redirigir(`/packs/gracias?pedido=${encodeURIComponent(p.id)}&k=${encodeURIComponent(k)}`);
}

async function leerTokenFlow(request) {
  const u = new URL(request.url);
  if (u.searchParams.get('token')) return u.searchParams.get('token');
  if (request.method === 'POST') {
    const f = await request.formData().catch(() => null);
    if (f && f.get('token')) return String(f.get('token'));
  }
  return null;
}

async function apiWebhookFlow(request, env, ctx) {
  const token = await leerTokenFlow(request);
  if (!token) return new Response('sin token', { status: 400 });
  try {
    await flowProcesarToken(env, token, ctx);
  } catch (e) {
    console.log('webhook flow', e.message);
    return new Response('reintentar', { status: 500 });
  }
  return new Response('ok');
}

async function apiRetornoFlow(request, env, ctx) {
  const u = new URL(request.url);
  const id = u.searchParams.get('pedido');
  const k = u.searchParams.get('k');
  const p = await pedidoConClave(env, id, k);
  if (!p) return redirigir('/packs/carrito');
  const token = await leerTokenFlow(request);
  if (token && p.estado !== 'pagado') {
    try {
      await flowProcesarToken(env, token, ctx);
    } catch (e) {
      console.log('retorno flow', e.message);
    }
  }
  return redirigir(`/packs/gracias?pedido=${encodeURIComponent(p.id)}&k=${encodeURIComponent(k)}`);
}

async function apiPedido(request, env) {
  const u = new URL(request.url);
  const p = await pedidoConClave(env, u.searchParams.get('pedido'), u.searchParams.get('k'));
  if (!p) return error('Pedido no encontrado.', 404);
  return json(pedidoPublico(p, await mapaPacks(env)));
}

async function apiDescarga(request, env, id, slug) {
  const u = new URL(request.url);
  const p = await pedidoConClave(env, id, u.searchParams.get('k'));
  const aviso = (msg, status) =>
    new Response(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Descarga</title><body style="font-family:sans-serif;padding:40px;color:#4a3b3f"><h1 style="color:#8f3a63">Descarga no disponible</h1><p>${escHtml(msg)}</p><p><a href="https://wa.me/56928133801">Escríbenos por WhatsApp</a> y te ayudamos.</p></body>`,
      { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
  if (!p) return aviso('No encontramos tu pedido.', 404);
  if (p.estado !== 'pagado') return aviso('Tu pago aún no está confirmado.', 403);
  if (p.expira && new Date(p.expira) < new Date()) return aviso('El enlace venció.', 410);
  if (p.descargas >= MAX_DESCARGAS) return aviso('Se alcanzó el máximo de descargas de este enlace.', 429);
  const items = JSON.parse(p.items);
  if (!items.some((i) => i.slug === slug)) return aviso('Este pack no es parte de tu pedido.', 404);
  const pack = await env.DB.prepare('SELECT archivo, archivo_bytes FROM packs WHERE slug = ?').bind(slug).first();
  const { results: partes } = await env.DB.prepare('SELECT parte FROM pack_archivos WHERE slug = ? ORDER BY parte').bind(slug).all();
  if (!pack || !pack.archivo_bytes || !partes.length) return aviso('El archivo no está disponible. Escríbenos y te lo enviamos.', 404);
  await env.DB.prepare('UPDATE pedidos SET descargas = descargas + 1 WHERE id = ?').bind(p.id).run();
  // Envía el PDF parte por parte, sin cargarlo entero en memoria.
  let i = 0;
  const cuerpo = new ReadableStream({
    async pull(control) {
      if (i >= partes.length) return control.close();
      const fila = await env.DB.prepare('SELECT datos FROM pack_archivos WHERE slug = ? AND parte = ?').bind(slug, partes[i].parte).first();
      i++;
      control.enqueue(new Uint8Array(fila.datos));
    },
  });
  return new Response(cuerpo, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(pack.archivo_bytes),
      'Content-Disposition': `attachment; filename="${pack.archivo}"`,
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

// ---------------------------------------------------------------------------
// Panel de administración
// ---------------------------------------------------------------------------
async function claveSesion(env) {
  return hmacHex(env.ADMIN_PASSWORD, 'vendolanas-sesion-admin');
}

async function sesionValida(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)vl_admin=([^;]+)/);
  if (!m) return false;
  const [exp, firma] = decodeURIComponent(m[1]).split('.');
  if (!exp || !firma || Number(exp) < Date.now()) return false;
  return igualesSeguro(await hmacHex(await claveSesion(env), exp), firma);
}

function mismoOrigen(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

async function apiLogin(request, env) {
  if (!env.ADMIN_PASSWORD) return error('Falta configurar ADMIN_PASSWORD en Cloudflare.', 503);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const desde = Date.now() - 15 * 60000;
  const fallos = await env.DB.prepare('SELECT COUNT(*) AS n FROM intentos_login WHERE ip = ? AND ts > ?').bind(ip, desde).first();
  if (fallos.n >= 8) return error('Demasiados intentos. Espera 15 minutos.', 429);
  const b = await leerJSON(request);
  if (!b || !(await igualesSeguro(String(b.password || ''), env.ADMIN_PASSWORD))) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO intentos_login (ip, ts) VALUES (?, ?)').bind(ip, Date.now()),
      env.DB.prepare('DELETE FROM intentos_login WHERE ts < ?').bind(Date.now() - 86400000),
    ]);
    return error('Contraseña incorrecta.', 401);
  }
  const exp = String(Date.now() + SESION_HORAS * 3600000);
  const valor = `${exp}.${await hmacHex(await claveSesion(env), exp)}`;
  const seguro = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return json({ ok: true }, 200, {
    'Set-Cookie': `vl_admin=${encodeURIComponent(valor)}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${SESION_HORAS * 3600}${seguro}`,
  });
}

function apiLogout() {
  return json({ ok: true }, 200, { 'Set-Cookie': 'vl_admin=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0' });
}

function pedidoAdmin(p) {
  return {
    id: p.id, nombre: p.nombre, email: p.email, items: JSON.parse(p.items), total: p.total, metodo: p.metodo,
    estado: p.estado, creado: p.creado, pagado_en: p.pagado_en, expira: p.expira, descargas: p.descargas,
    monto_pagado: p.monto_pagado, pago_ref: p.pago_ref, email_enviado: !!p.email_enviado, enlace: enlacePedido(p),
  };
}

async function apiAdminResumen(request, env) {
  const u = new URL(request.url);
  const estado = u.searchParams.get('estado') || '';
  const q = (u.searchParams.get('q') || '').trim().toLowerCase();
  const pagina = Math.max(0, Number(u.searchParams.get('pagina')) || 0);
  const where = [];
  const args = [];
  if (estado) { where.push('estado = ?'); args.push(estado); }
  if (q) { where.push('(lower(email) LIKE ? OR lower(nombre) LIKE ? OR lower(id) LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const inicioMes = new Date(); inicioMes.setUTCDate(1); inicioMes.setUTCHours(0, 0, 0, 0);
  const [lista, stats, mes, conteo] = await Promise.all([
    env.DB.prepare(`SELECT * FROM pedidos ${sqlWhere} ORDER BY creado DESC LIMIT 50 OFFSET ?`).bind(...args, pagina * 50).all(),
    env.DB.prepare("SELECT COUNT(*) AS ventas, COALESCE(SUM(total), 0) AS ingresos, COALESCE(SUM(descargas), 0) AS descargas FROM pedidos WHERE estado = 'pagado'").first(),
    env.DB.prepare("SELECT COUNT(*) AS ventas, COALESCE(SUM(total), 0) AS ingresos FROM pedidos WHERE estado = 'pagado' AND pagado_en >= ?").bind(inicioMes.toISOString()).first(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM pedidos ${sqlWhere}`).bind(...args).first(),
  ]);
  const pendientes = await env.DB.prepare("SELECT COUNT(*) AS n FROM pedidos WHERE estado IN ('pendiente', 'revisar')").first();
  return json({
    stats: { ...stats, mes_ventas: mes.ventas, mes_ingresos: mes.ingresos, pendientes: pendientes.n },
    pedidos: lista.results.map(pedidoAdmin),
    total: conteo.n,
    pagina,
    correo_activo: !!(env.RESEND_API_KEY && env.EMAIL_FROM),
    medios: { mp: !!env.MP_ACCESS_TOKEN, flow: !!(env.FLOW_API_KEY && env.FLOW_SECRET_KEY) },
  });
}

// Vuelve a consultar el estado al medio de pago (por si un aviso no llegó).
// Devuelve un mensaje si no se puede consultar; lanza si el medio de pago falla.
async function verificarConProveedor(env, p, ctx) {
  if (p.metodo === 'mp') {
    if (!env.MP_ACCESS_TOKEN) return 'Mercado Pago no está configurado.';
    const r = await fetch(`${mpBase(env)}/v1/payments/search?external_reference=${encodeURIComponent(p.id)}&sort=date_created&criteria=desc`, {
      headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` },
    });
    if (!r.ok) throw new Error(`Mercado Pago (búsqueda) respondió ${r.status}`);
    const data = await r.json().catch(() => ({}));
    const pagos = data.results || [];
    const aprobado = pagos.find((x) => x.status === 'approved') || pagos[0];
    if (aprobado) await mpProcesarPago(env, String(aprobado.id), ctx);
  } else if (p.proveedor_ref) {
    if (!(env.FLOW_API_KEY && env.FLOW_SECRET_KEY)) return 'Flow no está configurado.';
    await flowProcesarToken(env, p.proveedor_ref, ctx);
  }
  return null;
}

async function apiAdminAccion(request, env, id, accion, ctx) {
  const p = await obtenerPedido(env, id);
  if (!p) return error('Pedido no encontrado.', 404);
  if (accion === 'reiniciar') {
    if (p.estado !== 'pagado') return error('Solo se pueden reiniciar pedidos pagados.');
    await env.DB.prepare('UPDATE pedidos SET descargas = 0, expira = ? WHERE id = ?').bind(sumarDias(DIAS_VIGENCIA), id).run();
  } else if (accion === 'reenviar') {
    if (p.estado !== 'pagado') return error('El pedido no está pagado.');
    if (!(env.RESEND_API_KEY && env.EMAIL_FROM)) return error('El envío de correos no está configurado. Copia el enlace y envíalo por WhatsApp.');
    await enviarCorreo(env, p, true);
  } else if (accion === 'verificar') {
    const falla = await verificarConProveedor(env, p, ctx);
    if (falla) return error(falla);
  } else if (accion === 'eliminar') {
    // Antes de borrar un pedido no pagado, se confirma con el medio de pago que de verdad no se pagó.
    if (p.estado !== 'pagado' && p.proveedor_ref) {
      try {
        const falla = await verificarConProveedor(env, p, ctx);
        if (falla) return error(`${falla} No se eliminó el pedido.`);
      } catch (e) {
        console.log('eliminar/verificar', e.message);
        return error('No pudimos confirmar el estado con el medio de pago. Inténtalo de nuevo en unos minutos; el pedido no se eliminó.', 502);
      }
      const ahora = await obtenerPedido(env, id);
      if (ahora.estado === 'pagado') {
        return json({ error: 'Este pedido sí se pagó: el medio de pago lo confirmó recién y ya quedó como Pagado. No se eliminó.', pedido: pedidoAdmin(ahora) }, 409);
      }
    }
    await env.DB.prepare('DELETE FROM pedidos WHERE id = ?').bind(id).run();
    return json({ ok: true, eliminado: id });
  } else {
    return error('Acción desconocida.', 404);
  }
  return json({ ok: true, pedido: pedidoAdmin(await obtenerPedido(env, id)) });
}

async function apiAdminPacks(env) {
  const { results } = await env.DB.prepare('SELECT * FROM packs ORDER BY titulo').all();
  const { results: ventas } = await env.DB.prepare("SELECT items FROM pedidos WHERE estado = 'pagado'").all();
  const cuenta = {};
  for (const v of ventas) for (const i of JSON.parse(v.items)) cuenta[i.slug] = (cuenta[i.slug] || 0) + 1;
  return json({ packs: results.map((p) => ({ ...p, activo: !!p.activo, vendidos: cuenta[p.slug] || 0 })) });
}

async function apiAdminGuardarPack(request, env, slug) {
  const b = await leerJSON(request);
  if (!b) return error('Solicitud inválida.');
  const pack = await env.DB.prepare('SELECT * FROM packs WHERE slug = ?').bind(slug).first();
  if (!pack) return error('Pack no encontrado.', 404);
  const precio = Math.round(Number(b.precio));
  if (!Number.isFinite(precio) || precio < 500 || precio > 500000) return error('El precio debe estar entre $500 y $500.000.');
  const titulo = String(b.titulo || pack.titulo).trim().slice(0, 100);
  const descripcion = String(b.descripcion ?? pack.descripcion ?? '').trim().slice(0, 400);
  await env.DB.prepare('UPDATE packs SET titulo = ?, descripcion = ?, precio = ?, activo = ?, actualizado = ? WHERE slug = ?')
    .bind(titulo, descripcion, precio, b.activo ? 1 : 0, ahoraISO(), slug).run();
  return apiAdminPacks(env);
}

async function apiAdminSubirArchivo(request, env, slug) {
  const pack = await env.DB.prepare('SELECT slug FROM packs WHERE slug = ?').bind(slug).first();
  if (!pack) return error('Pack no encontrado.', 404);
  if (!(request.headers.get('Content-Type') || '').includes('application/pdf')) return error('El archivo debe ser un PDF.');
  const datos = new Uint8Array(await request.arrayBuffer());
  if (datos.length < 1000 || datos.length > MAX_ARCHIVO_BYTES) return error('El PDF debe pesar entre 1 KB y 20 MB.');
  if (String.fromCharCode(...datos.slice(0, 5)) !== '%PDF-') return error('El archivo no parece ser un PDF válido.');
  const sentencias = [env.DB.prepare('DELETE FROM pack_archivos WHERE slug = ?').bind(slug)];
  for (let i = 0, parte = 0; i < datos.length; i += TROZO_BYTES, parte++) {
    sentencias.push(env.DB.prepare('INSERT INTO pack_archivos (slug, parte, datos) VALUES (?, ?, ?)').bind(slug, parte, datos.slice(i, i + TROZO_BYTES).buffer));
  }
  sentencias.push(env.DB.prepare('UPDATE packs SET archivo_bytes = ?, archivo_subido = ? WHERE slug = ?').bind(datos.length, ahoraISO(), slug));
  await env.DB.batch(sentencias);
  return apiAdminPacks(env);
}

async function apiAdminVerArchivo(env, slug) {
  const pack = await env.DB.prepare('SELECT archivo, archivo_bytes FROM packs WHERE slug = ?').bind(slug).first();
  if (!pack || !pack.archivo_bytes) return error('Este pack aún no tiene PDF.', 404);
  const { results } = await env.DB.prepare('SELECT datos FROM pack_archivos WHERE slug = ? ORDER BY parte').bind(slug).all();
  const total = new Uint8Array(pack.archivo_bytes);
  let pos = 0;
  for (const r of results) { const t = new Uint8Array(r.datos); total.set(t, pos); pos += t.length; }
  return new Response(total, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${pack.archivo}"`, 'Cache-Control': 'no-store' } });
}

async function rutaAdmin(request, env, ctx, partes) {
  const m = request.method;
  if (partes[0] === 'login' && m === 'POST') return mismoOrigen(request) ? apiLogin(request, env) : error('Origen no permitido.', 403);
  if (partes[0] === 'logout' && m === 'POST') return apiLogout();
  if (!(await sesionValida(request, env))) return error('Sesión vencida. Vuelve a entrar.', 401);
  if (m !== 'GET' && !mismoOrigen(request)) return error('Origen no permitido.', 403);
  if (partes[0] === 'sesion' && m === 'GET') return json({ ok: true });
  if (partes[0] === 'ajustes' && m === 'GET') return json(await leerAjustes(env));
  if (partes[0] === 'ajustes' && m === 'PUT') return apiAdminGuardarAjustes(request, env);
  if (partes[0] === 'resumen' && m === 'GET') return apiAdminResumen(request, env);
  if (partes[0] === 'pedidos' && partes[1] && partes[2] && m === 'POST') return apiAdminAccion(request, env, partes[1], partes[2], ctx);
  if (partes[0] === 'packs' && !partes[1] && m === 'GET') return apiAdminPacks(env);
  if (partes[0] === 'packs' && partes[1] && partes[2] === 'archivo' && m === 'PUT') return apiAdminSubirArchivo(request, env, partes[1]);
  if (partes[0] === 'packs' && partes[1] && partes[2] === 'archivo' && m === 'GET') return apiAdminVerArchivo(env, partes[1]);
  if (partes[0] === 'packs' && partes[1] && !partes[2] && m === 'PUT') return apiAdminGuardarPack(request, env, partes[1]);
  return error('Ruta no encontrada.', 404);
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------
async function rutaApi(request, env, ctx) {
  const url = new URL(request.url);
  const partes = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const m = request.method;
  if (!env.DB) return error('Falta la base de datos D1 (binding DB).', 503);
  await prepararDB(env);

  switch (partes[0]) {
    case 'config':
      if (m === 'GET') return apiConfig(env);
      break;
    case 'packs':
      if (m === 'GET') return apiPacks(env);
      break;
    case 'checkout':
      if (m === 'POST') return mismoOrigen(request) ? apiCheckout(request, env) : error('Origen no permitido.', 403);
      break;
    case 'pedido':
      if (m === 'GET') return apiPedido(request, env);
      break;
    case 'descarga':
      if (m === 'GET' && partes[1] && partes[2]) return apiDescarga(request, env, partes[1], partes[2]);
      break;
    case 'webhooks':
      if (partes[1] === 'mercadopago' && m === 'POST') return apiWebhookMP(request, env, ctx);
      if (partes[1] === 'flow' && m === 'POST') return apiWebhookFlow(request, env, ctx);
      break;
    case 'retorno':
      if (partes[1] === 'mp' && m === 'GET') return apiRetornoMP(request, env, ctx);
      if (partes[1] === 'flow' && (m === 'POST' || m === 'GET')) return apiRetornoFlow(request, env, ctx);
      break;
    case 'admin':
      return rutaAdmin(request, env, ctx, partes.slice(1));
  }
  return error('Ruta no encontrada.', 404);
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      try {
        return await rutaApi(request, env, ctx);
      } catch (e) {
        console.log('error api', e.stack || e.message);
        return error('Ocurrió un error inesperado. Inténtalo de nuevo.', 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
