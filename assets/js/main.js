/* VendoLanas.cl · Comportamiento compartido (sin dependencias) */
(function () {
    'use strict';

    /* ---------- Menú móvil ---------- */
    var toggle = document.getElementById('menuToggle');
    var nav = document.getElementById('navLinks');
    if (toggle && nav) {
        var cerrar = function () {
            nav.classList.remove('abierto');
            toggle.setAttribute('aria-expanded', 'false');
            toggle.setAttribute('aria-label', 'Abrir menú');
        };
        toggle.addEventListener('click', function () {
            var abierto = nav.classList.toggle('abierto');
            toggle.setAttribute('aria-expanded', String(abierto));
            toggle.setAttribute('aria-label', abierto ? 'Cerrar menú' : 'Abrir menú');
        });
        nav.addEventListener('click', function (e) {
            if (e.target.closest('a')) { cerrar(); }
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { cerrar(); toggle.focus(); }
        });
    }

    /* ---------- Filtro de productos (index) ---------- */
    var botones = document.querySelectorAll('.filtro-btn');
    var grupos = document.querySelectorAll('#listaProductos .grupo-productos');
    var estado = document.getElementById('filtroEstado');

    function filtrar(categoria) {
        var visibles = 0;
        grupos.forEach(function (g) {
            var mostrar = categoria === 'todos' || g.getAttribute('data-categoria') === categoria;
            g.hidden = !mostrar;
            if (mostrar) { visibles += g.querySelectorAll('.producto-card').length; }
        });
        botones.forEach(function (b) {
            b.setAttribute('aria-pressed', String(b.getAttribute('data-filtro') === categoria));
        });
        if (estado) {
            estado.textContent = 'Mostrando ' + visibles + (visibles === 1 ? ' producto' : ' productos');
        }
    }

    if (botones.length && grupos.length) {
        botones.forEach(function (b) {
            b.addEventListener('click', function () { filtrar(b.getAttribute('data-filtro')); });
        });
        // Los enlaces a una categoría restablecen el filtro para que el grupo quede visible
        document.querySelectorAll('[data-ir-grupo]').forEach(function (a) {
            a.addEventListener('click', function () { filtrar('todos'); });
        });
    }

    /* ---------- Formulario de contacto: abre WhatsApp con el mensaje ---------- */
    var form = document.getElementById('formContacto');
    if (form) {
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var nombre = form.elements.nombre.value.trim();
            var producto = form.elements.producto.value;
            var mensaje = form.elements.mensaje.value.trim();
            var texto = 'Hola VendoLanas, soy ' + nombre + '.';
            if (producto) { texto += ' Me interesa: ' + producto + '.'; }
            if (mensaje) { texto += ' ' + mensaje; }
            var url = 'https://wa.me/' + form.getAttribute('data-wa') + '?text=' + encodeURIComponent(texto);
            window.open(url, '_blank', 'noopener');
        });
    }
})();
