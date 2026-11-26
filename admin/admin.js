(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var pagina = 0, totalPedidos = 0, correoActivo = false;
  function clp(n) { return '$' + Number(n || 0).toLocaleString('es-CL'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fecha(iso) { return iso ? new Date(iso).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' }) : ''; }
  var ESTADOS = { pagado: 'Pagado', pendiente: 'Pendiente', revisar: 'Revisar monto', rechazado: 'Rechazado', error: 'Error', reembolsado: 'Reembolsado' };

  function api(ruta, opciones) {
    opciones = opciones || {};
    opciones.credentials = 'same-origin';
    opciones.headers = Object.assign({ 'Content-Type': 'application/json' }, opciones.headers || {});
    return fetch('/api/admin/' + ruta, opciones).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401 && ruta !== 'login') { mostrarLogin(); throw new Error(d.error || 'Sesión vencida.'); }
        if (!r.ok) throw new Error(d.error || 'Error ' + r.status);
        return d;
      });
    });
  }
  function msg(el, texto, tipo) { el.textContent = texto; el.className = 'adm-msg ' + (tipo || ''); }

  function mostrarLogin() { $('#adm-login').hidden = false; $('#adm-app').hidden = true; $('#adm-salir').hidden = true; }
  function mostrarApp() { $('#adm-login').hidden = true; $('#adm-app').hidden = false; $('#adm-salir').hidden = false; cargarVentas(); }

  $('#adm-form-login').addEventListener('submit', function (e) {
    e.preventDefault();
    msg($('#adm-login-msg'), '');
    api('login', { method: 'POST', body: JSON.stringify({ password: $('#adm-pass').value }) })
      .then(function () { $('#adm-pass').value = ''; mostrarApp(); })
      .catch(function (err) { msg($('#adm-login-msg'), err.message, 'err'); });
  });
  $('#adm-salir').addEventListener('click', function () { api('logout', { method: 'POST' }).finally(mostrarLogin); });

  document.querySelectorAll('.adm-tab').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.adm-tab').forEach(function (x) { x.setAttribute('aria-selected', x === t ? 'true' : 'false'); });
      document.querySelectorAll('[data-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== t.getAttribute('data-tab'); });
      if (t.getAttribute('data-tab') === 'packs') cargarPacks(); else cargarVentas();
    });
  });

  function cargarVentas() {
    var q = encodeURIComponent($('#f-q').value.trim());
    var est = encodeURIComponent($('#f-estado').value);
    return api('resumen?pagina=' + pagina + '&q=' + q + '&estado=' + est).then(function (d) {
      $('#st-mes-ingresos').textContent = clp(d.stats.mes_ingresos);
      $('#st-mes-ventas').textContent = d.stats.mes_ventas;
      $('#st-ingresos').textContent = clp(d.stats.ingresos);
      $('#st-ventas').textContent = d.stats.ventas;
      $('#st-pendientes').textContent = d.stats.pendientes;
      correoActivo = d.correo_activo;
      $('#adm-config').innerHTML = [['Mercado Pago', d.medios.mp], ['Flow', d.medios.flow], ['Envío de correos', d.correo_activo]]
        .map(function (x) { return '<span>' + (x[1] ? '✅ ' : '⚠️ ') + x[0] + (x[1] ? ' activo' : ' sin configurar') + '</span>'; }).join('');
      totalPedidos = d.total;
      $('#pag-info').textContent = d.total ? (pagina * 50 + 1) + '–' + Math.min(d.total, pagina * 50 + 50) + ' de ' + d.total : '';
      $('#pag-ant').disabled = pagina === 0;
      $('#pag-sig').disabled = (pagina + 1) * 50 >= d.total;
      if (!d.pedidos.length) { $('#adm-filas').innerHTML = '<tr><td colspan="9">Aún no hay pedidos con estos filtros.</td></tr>'; return; }
      $('#adm-filas').innerHTML = d.pedidos.map(fila).join('');
    }).catch(function (e) { msg($('#adm-msg'), e.message, 'err'); });
  }

  function fila(p) {
    var pagado = p.estado === 'pagado';
    return '<tr data-id="' + esc(p.id) + '" data-enlace="' + esc(p.enlace) + '">' +
      '<td>' + esc(fecha(p.creado)) + '</td>' +
      '<td><code>' + esc(p.id) + '</code></td>' +
      '<td>' + esc(p.nombre) + '<br><small>' + esc(p.email) + '</small></td>' +
      '<td>' + p.items.map(function (i) { return esc(i.titulo); }).join('<br>') + '</td>' +
      '<td>' + clp(p.total) + (p.monto_pagado != null && p.monto_pagado !== p.total ? '<br><small>Pagó ' + clp(p.monto_pagado) + '</small>' : '') + '</td>' +
      '<td>' + (p.metodo === 'mp' ? 'Mercado Pago' : 'Flow') + '</td>' +
      '<td><span class="adm-estado e-' + esc(p.estado) + '">' + esc(ESTADOS[p.estado] || p.estado) + '</span>' + (p.pagado_en ? '<br><small>' + esc(fecha(p.pagado_en)) + '</small>' : '') + '</td>' +
      '<td>' + (pagado ? p.descargas + '/15' : '—') + '</td>' +
      '<td><div class="adm-acc">' +
        '<button type="button" data-acc="copiar"' + (pagado ? '' : ' disabled') + '>Copiar enlace</button>' +
        '<button type="button" data-acc="verificar"' + (pagado ? ' disabled' : '') + '>Verificar pago</button>' +
        '<button type="button" data-acc="reiniciar"' + (pagado ? '' : ' disabled') + '>Reiniciar descargas</button>' +
        '<button type="button" data-acc="reenviar"' + (pagado && correoActivo ? '' : ' disabled') + ' title="' + (correoActivo ? '' : 'Configura RESEND_API_KEY para enviar correos') + '">Reenviar correo</button>' +
      '</div></td></tr>';
  }

  $('#adm-filas').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-acc]');
    if (!b || b.disabled) return;
    var tr = b.closest('tr'); var id = tr.getAttribute('data-id'); var acc = b.getAttribute('data-acc');
    var m = $('#adm-msg');
    if (acc === 'copiar') {
      var enlace = tr.getAttribute('data-enlace');
      (navigator.clipboard ? navigator.clipboard.writeText(enlace) : Promise.reject())
        .then(function () { msg(m, 'Enlace del pedido ' + id + ' copiado. Puedes enviarlo por WhatsApp.', 'ok'); })
        .catch(function () { window.prompt('Copia el enlace del pedido:', enlace); });
      return;
    }
    if (acc === 'reiniciar' && !window.confirm('¿Reiniciar el contador de descargas y extender el enlace 60 días?')) return;
    b.disabled = true;
    api('pedidos/' + encodeURIComponent(id) + '/' + acc, { method: 'POST', body: '{}' })
      .then(function (d) {
        var textos = { verificar: 'Estado consultado al medio de pago: ' + (ESTADOS[d.pedido.estado] || d.pedido.estado) + '.', reiniciar: 'Descargas reiniciadas.', reenviar: 'Correo reenviado a ' + d.pedido.email + '.' };
        msg(m, textos[acc], 'ok');
        cargarVentas();
      })
      .catch(function (err) { msg(m, err.message, 'err'); b.disabled = false; });
  });

  var tBuscar;
  $('#f-q').addEventListener('input', function () { clearTimeout(tBuscar); tBuscar = setTimeout(function () { pagina = 0; cargarVentas(); }, 350); });
  $('#f-estado').addEventListener('change', function () { pagina = 0; cargarVentas(); });
  $('#f-actualizar').addEventListener('click', function () { msg($('#adm-msg'), ''); cargarVentas(); });
  $('#pag-ant').addEventListener('click', function () { if (pagina > 0) { pagina--; cargarVentas(); } });
  $('#pag-sig').addEventListener('click', function () { if ((pagina + 1) * 50 < totalPedidos) { pagina++; cargarVentas(); } });

  function cargarPacks() {
    return api('packs').then(function (d) {
      $('#adm-packs').innerHTML = d.packs.map(function (p) {
        return '<tr data-slug="' + esc(p.slug) + '">' +
          '<td><input type="text" class="adm-input" name="titulo" value="' + esc(p.titulo) + '" maxlength="100" aria-label="Título"><br><small><a href="' + esc(p.pagina || '/packs/') + '" target="_blank" rel="noopener">Ver página</a></small></td>' +
          '<td><textarea class="adm-input" name="descripcion" maxlength="400" aria-label="Descripción">' + esc(p.descripcion) + '</textarea></td>' +
          '<td><input type="number" class="adm-input" name="precio" value="' + p.precio + '" min="500" max="500000" step="10" aria-label="Precio"></td>' +
          '<td><input type="checkbox" name="activo"' + (p.activo ? ' checked' : '') + ' aria-label="Activo"></td>' +
          '<td class="adm-archivo">' + (p.archivo_bytes
            ? '<span class="adm-listo">✓ Subido</span> (' + (p.archivo_bytes / 1048576).toFixed(1).replace('.', ',') + ' MB)<br><small>' + esc(fecha(p.archivo_subido)) + '</small><br><a href="/api/admin/packs/' + encodeURIComponent(p.slug) + '/archivo" target="_blank" rel="noopener">Ver PDF</a>'
            : '<span class="adm-falta">Falta subir el PDF</span>') +
          '<br><input type="file" accept="application/pdf" name="archivo" aria-label="Elegir PDF"><br><button type="button" class="btn btn-outline btn-sm" data-subir>' + (p.archivo_bytes ? 'Reemplazar PDF' : 'Subir PDF') + '</button></td>' +
          '<td>' + p.vendidos + '</td>' +
          '<td><button type="button" class="btn btn-sm" data-guardar>Guardar</button></td></tr>';
      }).join('');
    }).catch(function (e) { msg($('#adm-msg-packs'), e.message, 'err'); });
  }

  $('#adm-packs').addEventListener('click', function (e) {
    var sub = e.target.closest('[data-subir]');
    if (sub) {
      var trs = sub.closest('tr'); var input = trs.querySelector('input[name=archivo]');
      var archivo = input.files && input.files[0];
      if (!archivo) { msg($('#adm-msg-packs'), 'Primero elige el archivo PDF.', 'err'); return; }
      if (archivo.type !== 'application/pdf') { msg($('#adm-msg-packs'), 'El archivo debe ser un PDF.', 'err'); return; }
      sub.disabled = true; sub.textContent = 'Subiendo…';
      fetch('/api/admin/packs/' + encodeURIComponent(trs.getAttribute('data-slug')) + '/archivo', {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/pdf' }, body: archivo
      }).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Error ' + r.status); return d; }); })
        .then(function () { msg($('#adm-msg-packs'), 'PDF subido. El pack ya se puede vender.', 'ok'); cargarPacks(); })
        .catch(function (err) { msg($('#adm-msg-packs'), err.message, 'err'); sub.disabled = false; sub.textContent = 'Subir PDF'; });
      return;
    }
    var b = e.target.closest('[data-guardar]');
    if (!b) return;
    var tr = b.closest('tr');
    var body = {
      titulo: tr.querySelector('[name=titulo]').value,
      descripcion: tr.querySelector('[name=descripcion]').value,
      precio: Number(tr.querySelector('[name=precio]').value),
      activo: tr.querySelector('[name=activo]').checked
    };
    api('packs/' + encodeURIComponent(tr.getAttribute('data-slug')), { method: 'PUT', body: JSON.stringify(body) })
      .then(function () { msg($('#adm-msg-packs'), 'Pack guardado.', 'ok'); cargarPacks(); })
      .catch(function (err) { msg($('#adm-msg-packs'), err.message, 'err'); });
  });

  api('sesion').then(mostrarApp).catch(mostrarLogin);
})();
