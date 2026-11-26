/* Carrito de packs digitales de VendoLanas.cl
   Solo para productos digitales: las lanas se siguen pidiendo por WhatsApp. */
(function () {
  'use strict';
  var CLAVE = 'vl_carrito_packs';
  var RESPALDO = {
    'pack-aros-a-crochet': { slug: 'pack-aros-a-crochet', titulo: 'Pack digital: Aros a crochet', precio: 3990, pagina: '/packs/pack-aros-a-crochet.html' }
  };
  var IMAGEN = { 'pack-aros-a-crochet': '/assets/img/packs/pack-aros-a-crochet-portada.webp' };
  var memoria = [];
  var catalogo = null;

  function leer() {
    try {
      var v = JSON.parse(window.localStorage.getItem(CLAVE) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) { return memoria.slice(); }
  }
  function guardar(lista) {
    memoria = lista.slice();
    try { window.localStorage.setItem(CLAVE, JSON.stringify(lista)); } catch (e) { /* sin almacenamiento */ }
    contador();
  }
  function agregar(slug) { var l = leer(); if (l.indexOf(slug) === -1) l.push(slug); guardar(l); }
  function quitar(slug) { guardar(leer().filter(function (s) { return s !== slug; })); }
  function clp(n) { return '$' + Number(n).toLocaleString('es-CL'); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function contador() {
    var n = leer().length;
    document.querySelectorAll('[data-carrito-cantidad]').forEach(function (el) { el.textContent = n; });
  }

  function cargarCatalogo() {
    if (catalogo) return Promise.resolve(catalogo);
    return fetch('/api/packs', { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (d) {
        catalogo = {};
        d.packs.forEach(function (p) { catalogo[p.slug] = p; });
        return catalogo;
      })
      .catch(function () { catalogo = Object.assign({}, RESPALDO); return catalogo; });
  }

  function actualizarPrecios() {
    var els = document.querySelectorAll('[data-precio-pack]');
    if (!els.length) return;
    cargarCatalogo().then(function (cat) {
      els.forEach(function (el) {
        var p = cat[el.getAttribute('data-precio-pack')];
        if (p) el.textContent = clp(p.precio);
      });
    });
  }

  function botones() {
    document.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-agregar-pack], [data-comprar-pack]');
      if (!b) return;
      ev.preventDefault();
      var slug = b.getAttribute('data-agregar-pack') || b.getAttribute('data-comprar-pack');
      agregar(slug);
      if (b.hasAttribute('data-comprar-pack')) {
        window.location.href = '/packs/carrito.html';
        return;
      }
      var aviso = b.closest('.pk-acciones') && b.closest('.pk-acciones').nextElementSibling;
      if (aviso && aviso.classList.contains('pk-aviso')) {
        aviso.innerHTML = 'Agregado a tu carrito. <a href="/packs/carrito.html">Ir a pagar</a>';
      }
      b.textContent = 'Agregado ✓';
    });
  }

  // ---------- Página del carrito ----------
  function paginaCarrito(raiz) {
    var lista = raiz.querySelector('#pk-items');
    var total = raiz.querySelector('#pk-total');
    var form = raiz.querySelector('#pk-form');
    var errorBox = raiz.querySelector('#pk-error');
    var boton = raiz.querySelector('#pk-pagar');

    function pintar() {
      cargarCatalogo().then(function (cat) {
        var items = leer().filter(function (s) { return cat[s]; });
        if (items.length !== leer().length) guardar(items);
        if (!items.length) {
          lista.innerHTML = '<div class="pk-vacio"><p>Tu carrito está vacío.</p><a class="btn btn-outline" href="/packs/">Ver packs digitales</a></div>';
          total.textContent = clp(0);
          boton.disabled = true;
          return;
        }
        boton.disabled = false;
        var suma = 0;
        lista.innerHTML = items.map(function (s) {
          var p = cat[s]; suma += p.precio;
          return '<div class="pk-item"><img src="' + (IMAGEN[s] || '/assets/img/packs/' + s + '-portada.webp') + '" alt="" width="72" height="72">' +
            '<div><h3><a href="' + esc(p.pagina || '/packs/') + '">' + esc(p.titulo) + '</a></h3><button type="button" class="pk-quitar" data-quitar="' + esc(s) + '">Quitar</button></div>' +
            '<strong>' + clp(p.precio) + '</strong></div>';
        }).join('');
        total.textContent = clp(suma);
      });
    }

    lista.addEventListener('click', function (ev) {
      var q = ev.target.closest('[data-quitar]');
      if (q) { quitar(q.getAttribute('data-quitar')); pintar(); }
    });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      errorBox.hidden = true;
      var datos = new FormData(form);
      var email = String(datos.get('email') || '').trim();
      if (email.toLowerCase() !== String(datos.get('email2') || '').trim().toLowerCase()) {
        return mostrarError('Los correos no coinciden. Revísalos: ahí te enviamos tu enlace.');
      }
      if (!datos.get('metodo')) return mostrarError('Elige un medio de pago.');
      if (!datos.get('acepto')) return mostrarError('Debes aceptar las condiciones de compra digital.');
      boton.disabled = true;
      boton.textContent = 'Conectando con el medio de pago…';
      fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: leer(), nombre: datos.get('nombre'), email: email, metodo: datos.get('metodo') })
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok || !res.d.url) throw new Error(res.d.error || 'No pudimos iniciar el pago.');
          window.location.href = res.d.url;
        })
        .catch(function (e) {
          mostrarError(e.message && e.message !== 'Failed to fetch' ? e.message : 'No pudimos conectar. Revisa tu conexión e inténtalo de nuevo.');
          boton.disabled = false;
          boton.textContent = 'Ir a pagar';
        });
    });

    function mostrarError(m) { errorBox.textContent = m; errorBox.hidden = false; }
    pintar();
  }

  // ---------- Página de gracias / descarga ----------
  function paginaGracias(raiz) {
    var q = new URLSearchParams(window.location.search);
    var pedido = q.get('pedido'); var k = q.get('k');
    var caja = raiz.querySelector('#pk-resultado');
    var intentos = 0;
    if (!pedido || !k) {
      caja.innerHTML = '<h2>No encontramos tu pedido</h2><p>Abre el enlace completo que recibiste o escríbenos por WhatsApp al +56 9 2813 3801.</p>';
      return;
    }
    function consultar() {
      fetch('/api/pedido?pedido=' + encodeURIComponent(pedido) + '&k=' + encodeURIComponent(k))
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.d.error || 'Pedido no encontrado.');
          var d = res.d;
          if (d.estado === 'pagado') {
            guardar(leer().filter(function (s) { return !d.items.some(function (i) { return i.slug === s; }); }));
            caja.innerHTML = '<h2>¡Pago confirmado!</h2><p>Pedido <strong>' + esc(d.id) + '</strong> · ' + clp(d.total) + '</p>' +
              '<div class="pk-descargas">' + d.descargas.map(function (x) {
                return '<a class="btn btn-primario" href="' + esc(x.url) + '">Descargar ' + esc(x.titulo) + ' (PDF)</a>';
              }).join('') + '</div>' +
              '<p class="pk-aviso">Guarda esta página en tus favoritos: el enlace funciona hasta el ' + new Date(d.expira).toLocaleDateString('es-CL') +
              ' y te quedan ' + d.descargas_restantes + ' descargas.</p>' +
              '<p><button type="button" class="btn btn-outline btn-sm" id="pk-copiar">Copiar enlace de esta página</button></p>';
            var c = document.getElementById('pk-copiar');
            if (c) c.addEventListener('click', function () {
              (navigator.clipboard ? navigator.clipboard.writeText(window.location.href) : Promise.reject())
                .then(function () { c.textContent = 'Enlace copiado ✓'; })
                .catch(function () { c.textContent = 'Copia la dirección de tu navegador'; });
            });
            return;
          }
          if (d.estado === 'pendiente' && intentos < 45) {
            intentos++;
            caja.innerHTML = '<div class="pk-cargando" aria-hidden="true"></div><h2>Estamos confirmando tu pago…</h2><p>Esto suele tardar unos segundos. No cierres esta página.</p>';
            setTimeout(consultar, 4000);
            return;
          }
          if (d.estado === 'rechazado' || d.estado === 'error') {
            caja.innerHTML = '<h2>El pago no se completó</h2><p>No se realizó ningún cobro por este pedido. Puedes intentarlo de nuevo con otro medio de pago.</p><p><a class="btn btn-primario" href="/packs/carrito.html">Volver al carrito</a></p>';
            return;
          }
          caja.innerHTML = '<h2>Tu pago está en revisión</h2><p>Aún no recibimos la confirmación del medio de pago. Si ya pagaste, escríbenos por WhatsApp al <a href="https://wa.me/56928133801">+56 9 2813 3801</a> con tu número de pedido <strong>' + esc(d.id) + '</strong> y te enviamos tu pack.</p>';
        })
        .catch(function (e) {
          caja.innerHTML = '<h2>No pudimos cargar tu pedido</h2><p>' + esc(e.message || '') + ' Escríbenos por WhatsApp al +56 9 2813 3801 y te ayudamos.</p>';
        });
    }
    consultar();
  }

  document.addEventListener('DOMContentLoaded', function () {
    contador();
    botones();
    actualizarPrecios();
    var c = document.getElementById('pk-carrito');
    if (c) paginaCarrito(c);
    var g = document.getElementById('pk-gracias');
    if (g) paginaGracias(g);
  });
})();
