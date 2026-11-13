/**
 * toolbar.js
 * Desplegables de la barra superior (Archivo / Vista en celulares) y menú vertical
 * flotante arrastrable. Animaciones con GSAP.
 */
(function () {
    const menus = Array.from(document.querySelectorAll('#top-bar .menu'));
    let openMenu = null;

    /* ---------- Paneles (animación de apertura / cierre) ---------- */

    function showPanel(panel, fromX = 0, fromY = -6) {
        gsap.killTweensOf(panel);
        panel.hidden = false;
        gsap.fromTo(panel,
            { autoAlpha: 0, x: fromX, y: fromY },
            { autoAlpha: 1, x: 0, y: 0, duration: 0.18, ease: 'power2.out' });
        gsap.fromTo(panel.querySelectorAll(':scope > button, :scope > .menu-sub'),
            { autoAlpha: 0, y: -4 },
            { autoAlpha: 1, y: 0, duration: 0.16, ease: 'power2.out', stagger: 0.02 });
    }

    function hidePanel(panel) {
        if (panel.hidden) return;
        gsap.killTweensOf(panel);
        gsap.to(panel, {
            autoAlpha: 0, y: -4, duration: 0.12, ease: 'power1.in',
            onComplete: () => { panel.hidden = true; },
        });
    }

    function closeSubmenus(menu) {
        menu.querySelectorAll('.menu-sub').forEach(sub => {
            sub.classList.remove('open');
            hidePanel(sub.querySelector('.menu-subpanel'));
        });
    }

    function closeMenu(menu) {
        if (!menu) return;
        closeSubmenus(menu);
        menu.classList.remove('open');
        menu.querySelector('.menu-trigger').setAttribute('aria-expanded', 'false');
        hidePanel(menu.querySelector(':scope > .menu-panel'));
        if (openMenu === menu) openMenu = null;
    }

    function open(menu) {
        if (openMenu && openMenu !== menu) closeMenu(openMenu);
        openMenu = menu;
        menu.classList.add('open');
        menu.querySelector('.menu-trigger').setAttribute('aria-expanded', 'true');
        showPanel(menu.querySelector(':scope > .menu-panel'));
    }

    menus.forEach(menu => {
        const trigger = menu.querySelector('.menu-trigger');

        trigger.addEventListener('click', e => {
            e.stopPropagation();
            if (openMenu === menu) closeMenu(menu); else open(menu);
        });

        // Con un menú ya abierto, pasar el mouse a otro lo abre (como en un menú de escritorio)
        trigger.addEventListener('mouseenter', () => {
            if (openMenu && openMenu !== menu) open(menu);
        });

        // Submenús (Exportar)
        menu.querySelectorAll('.menu-sub').forEach(sub => {
            const subPanel = sub.querySelector('.menu-subpanel');
            const openSub = () => {
                if (sub.classList.contains('open')) return;
                if (sub.querySelector('.menu-sub-trigger').disabled) return;
                sub.classList.add('open');
                showPanel(subPanel, -6, 0);
            };
            const closeSub = () => {
                sub.classList.remove('open');
                hidePanel(subPanel);
            };
            sub.addEventListener('mouseenter', openSub);
            sub.addEventListener('mouseleave', closeSub);
            sub.querySelector('.menu-sub-trigger').addEventListener('click', e => {
                e.stopPropagation();
                if (sub.classList.contains('open')) closeSub(); else openSub();
            });
        });

        // Elegir una opción cierra el menú (la acción la maneja app.js)
        menu.querySelectorAll('.menu-panel button:not(.menu-sub-trigger)').forEach(item => {
            item.addEventListener('click', () => closeMenu(menu));
        });
    });

    document.addEventListener('click', e => {
        if (openMenu && !openMenu.contains(e.target)) closeMenu(openMenu);
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && openMenu) {
            e.preventDefault();
            e.stopPropagation();
            closeMenu(openMenu);
        }
    }, true);

    /* ---------- Menús verticales flotantes arrastrables ---------- */

    const main = document.getElementById('main');
    const floatingBars = ['side-tools', 'edit-tools']
        .map(id => document.getElementById(id))
        .filter(Boolean);

    if (window.Draggable) {
        gsap.registerPlugin(Draggable);
        floatingBars.forEach(bar => {
            Draggable.create(bar, {
                type: 'x,y',
                trigger: bar.querySelector('.side-grip'),
                bounds: main,
                inertia: false,
                onPress() { gsap.to(bar, { scale: 1.04, duration: 0.15, ease: 'power2.out' }); },
                onRelease() { gsap.to(bar, { scale: 1, duration: 0.2, ease: 'power2.out' }); },
            });
        });

        // Al redimensionar la ventana, mantener los menús dentro del área visible
        window.addEventListener('resize', () => {
            floatingBars.forEach(bar => Draggable.get(bar).applyBounds(main));
        });
    }

    /* ---------- Miniaturas (botón de la izquierda; en celulares Vista > Miniaturas) (mostrar / ocultar la lista de miniaturas) ---------- */

    const btnThumbView = document.getElementById('btn-thumbnail-view');
    const thumbList = document.getElementById('thumbnail-list');
    const thumbResizer = document.getElementById('thumb-resizer');
    const editTools = document.getElementById('edit-tools');
    const THUMB_DEFAULT_WIDTH = 150;
    const THUMB_MIN_WIDTH = 110;
    const THUMB_MAX_WIDTH = 420;
    // Posición del menú izquierdo: a la derecha de las miniaturas (padding de #main 9 + ancho + gap 4 + margen 16),
    // o pegado al borde si están ocultas
    const editToolsLeftFor = w => 9 + w + 4 + 16;
    const btnThumbToggle = document.getElementById('btn-thumb-toggle');
    // Cerrado, el panel no desaparece: queda una franja angosta que contiene el botón abrir/cerrar
    const THUMB_COLLAPSED_WIDTH = 42;
    const EDIT_TOOLS_LEFT_NO_THUMBS = editToolsLeftFor(THUMB_COLLAPSED_WIDTH);
    // Posición del botón abrir/cerrar: arriba a la derecha del panel, o centrado en la franja si está cerrado
    const thumbToggleLeftFor = w => 9 + w - 34;
    const THUMB_TOGGLE_LEFT_CLOSED = 9 + (THUMB_COLLAPSED_WIDTH - 28) / 2;
    // Al iniciar el panel está cerrado: se abre sólo cuando el usuario toca el botón
    let thumbsOpen = false;
    thumbList.classList.add('collapsed');
    editTools.style.left = `${EDIT_TOOLS_LEFT_NO_THUMBS}px`;
    btnThumbToggle.style.left = `${THUMB_TOGGLE_LEFT_CLOSED}px`;

    let thumbWidth = THUMB_DEFAULT_WIDTH;
    try {
        const saved = parseInt(localStorage.getItem('thumbWidth'), 10);
        if (saved >= THUMB_MIN_WIDTH && saved <= THUMB_MAX_WIDTH) thumbWidth = saved;
    } catch (_) { /* sin almacenamiento: ancho por defecto */ }

    function applyThumbWidth(w, min = THUMB_MIN_WIDTH) {
        thumbWidth = Math.round(Math.min(THUMB_MAX_WIDTH, Math.max(min, w)));
        document.documentElement.style.setProperty('--thumb-w', `${thumbWidth}px`);
        if (thumbsOpen) editTools.style.left = `${editToolsLeftFor(thumbWidth)}px`;
    }

    function thumbWidthChanged() {
        try { localStorage.setItem('thumbWidth', String(thumbWidth)); } catch (_) { /* opcional */ }
        if (window.Draggable && Draggable.get(editTools)) Draggable.get(editTools).applyBounds(main);
        window.dispatchEvent(new CustomEvent('thumbnails-resized'));
    }

    applyThumbWidth(thumbWidth);
    const savedThumbWidth = thumbWidth;
    const THUMB_MOBILE_WIDTH = 90;

    // Arrastrar el divisor cambia el ancho del panel de miniaturas
    thumbResizer.addEventListener('pointerdown', e => {
        if (e.button !== 0 || !thumbsOpen) return;
        e.preventDefault();
        const startX = e.clientX;
        const startW = thumbWidth;
        thumbResizer.setPointerCapture(e.pointerId);
        thumbResizer.classList.add('active');
        document.body.classList.add('resizing-thumbs');
        const onMove = ev => applyThumbWidth(startW + ev.clientX - startX);
        const onUp = () => {
            thumbResizer.classList.remove('active');
            document.body.classList.remove('resizing-thumbs');
            thumbResizer.removeEventListener('pointermove', onMove);
            thumbResizer.removeEventListener('pointerup', onUp);
            thumbResizer.removeEventListener('pointercancel', onUp);
            if (thumbWidth !== startW) thumbWidthChanged();
        };
        thumbResizer.addEventListener('pointermove', onMove);
        thumbResizer.addEventListener('pointerup', onUp);
        thumbResizer.addEventListener('pointercancel', onUp);
    });

    // Doble clic: vuelve al ancho original
    thumbResizer.addEventListener('dblclick', () => {
        if (!thumbsOpen || thumbWidth === THUMB_DEFAULT_WIDTH) return;
        const proxy = { w: thumbWidth };
        gsap.to(proxy, {
            w: THUMB_DEFAULT_WIDTH, duration: 0.3, ease: 'power2.inOut',
            onUpdate: () => applyThumbWidth(proxy.w),
            onComplete: thumbWidthChanged,
        });
    });

    function setThumbsVisible(show) {
        thumbsOpen = show;
        document.body.classList.toggle('thumbs-open', show);
        // Celulares: panel angosto para que la hoja tenga lugar (no se guarda como preferencia)
        if (show && MOBILE_QUERY.matches) applyThumbWidth(THUMB_MOBILE_WIDTH, THUMB_MOBILE_WIDTH);
        else if (show && thumbWidth === THUMB_MOBILE_WIDTH) applyThumbWidth(savedThumbWidth);
        btnThumbView.setAttribute('aria-checked', String(show));
        btnThumbToggle.setAttribute('aria-pressed', String(show));
        btnThumbToggle.title = show ? 'Ocultar miniaturas' : 'Mostrar miniaturas';

        gsap.killTweensOf([thumbList, editTools, thumbResizer, btnThumbToggle]);
        gsap.fromTo(btnThumbToggle,
            { left: show ? THUMB_TOGGLE_LEFT_CLOSED : thumbToggleLeftFor(thumbWidth) },
            { left: show ? thumbToggleLeftFor(thumbWidth) : THUMB_TOGGLE_LEFT_CLOSED, duration: 0.3, ease: 'power2.inOut',
              // abierto: vuelve a seguir el ancho del panel por CSS (--thumb-w)
              onComplete: () => { if (show) gsap.set(btnThumbToggle, { clearProps: 'left' }); } });
        if (show) {
            thumbList.classList.remove('collapsed');
            gsap.fromTo(thumbList,
                { width: THUMB_COLLAPSED_WIDTH, flexBasis: THUMB_COLLAPSED_WIDTH },
                { width: thumbWidth, flexBasis: thumbWidth, duration: 0.3, ease: 'power2.out',
                  clearProps: 'width,flexBasis',
                  onComplete: () => {
                      window.dispatchEvent(new CustomEvent('thumbnails-resized'));
                      window.dispatchEvent(new CustomEvent('thumbnails-toggled'));
                  } });
            gsap.fromTo(thumbResizer, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2, delay: 0.25, clearProps: 'opacity,visibility' });
        } else {
            gsap.set(thumbResizer, { autoAlpha: 0 });
            gsap.fromTo(thumbList,
                { width: thumbWidth, flexBasis: thumbWidth },
                { width: THUMB_COLLAPSED_WIDTH, flexBasis: THUMB_COLLAPSED_WIDTH, duration: 0.25, ease: 'power2.in',
                  onComplete: () => {
                      thumbList.classList.add('collapsed');
                      gsap.set([thumbList, thumbResizer], { clearProps: 'width,flexBasis,opacity,visibility' });
                      window.dispatchEvent(new CustomEvent('thumbnails-toggled'));
                  } });
        }
        gsap.to(editTools, {
            left: show ? editToolsLeftFor(thumbWidth) : EDIT_TOOLS_LEFT_NO_THUMBS,
            duration: 0.3, ease: 'power2.inOut',
        });
    }

    btnThumbView.addEventListener('click', () => setThumbsVisible(btnThumbView.getAttribute('aria-checked') !== 'true'));
    btnThumbToggle.addEventListener('click', () => setThumbsVisible(btnThumbToggle.getAttribute('aria-pressed') !== 'true'));

    /* ---------- Opciones de la herramienta (color / grosor) ---------- */

    // Qué opciones usa cada modo (según cómo los dibuja app.js)
    const TOOL_OPTIONS = {
        draw: { color: true, width: true },
        rect: { color: true, width: true },
        arrow: { color: true, width: true },
        line: { color: true, width: true },
        highlight: { color: true, width: false },
        underline: { color: true, width: false },
        strike: { color: true, width: false },
        note: { palette: true },
    };

    const toolOptions = document.getElementById('tool-options');
    const optColor = toolOptions.querySelector('.tool-opt-color');
    const optWidth = toolOptions.querySelector('.tool-opt-width');
    const optPalette = toolOptions.querySelector('.tool-opt-palette');
    const optHl = toolOptions.querySelector('.tool-opt-hl');
    gsap.set(toolOptions, { yPercent: -50 });

    function updateToolOptions(radio) {
        const opts = TOOL_OPTIONS[radio.value];
        if (!opts) {
            if (!toolOptions.hidden) {
                gsap.killTweensOf(toolOptions);
                gsap.to(toolOptions, {
                    autoAlpha: 0, x: -8, duration: 0.14, ease: 'power1.in',
                    onComplete: () => { toolOptions.hidden = true; },
                });
            }
            return;
        }

        // Celulares: el resaltador usa colores fijos en vez del selector de color del sistema
        const hlPalette = radio.value === 'highlight' && MOBILE_QUERY.matches;
        optColor.hidden = !opts.color || hlPalette;
        optHl.hidden = !hlPalette;
        optWidth.hidden = !opts.width;
        optPalette.hidden = !opts.palette;

        // Se abre a la derecha, a la altura de la herramienta elegida
        const tool = radio.closest('.tool-group')?.querySelector('.group-toggle') || radio.closest('.tool');
        toolOptions.style.top = `${tool.offsetTop + tool.offsetHeight / 2}px`;

        gsap.killTweensOf(toolOptions);
        toolOptions.hidden = false;
        gsap.fromTo(toolOptions,
            { autoAlpha: 0, x: -8 },
            { autoAlpha: 1, x: 0, duration: 0.2, ease: 'power2.out' });
    }

    document.querySelectorAll('#edit-tools input[name="mode"]').forEach(radio => {
        radio.addEventListener('change', () => { if (radio.checked) updateToolOptions(radio); });
        // Volver a pulsar la herramienta activa reabre sus opciones si se habían retraído
        radio.addEventListener('click', () => { if (radio.checked && toolOptions.hidden) updateToolOptions(radio); });
    });

    // Las opciones se retraen cuando el mouse se aleja más de 60 px (se arma al acercarse una vez)
    const RETRACT_DISTANCE = 60;
    let retractArmed = false;
    new MutationObserver(() => { retractArmed = false; })
        .observe(toolOptions, { attributes: true, attributeFilter: ['hidden'] });

    document.addEventListener('pointermove', e => {
        if (toolOptions.hidden) return;
        const r = toolOptions.getBoundingClientRect();
        const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
        const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
        const dist = Math.hypot(dx, dy);
        if (dist <= RETRACT_DISTANCE) { retractArmed = true; return; }
        if (!retractArmed) return;
        // No retraer mientras se edita un campo de las opciones o está abierto el selector de color
        if (toolOptions.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
        retractArmed = false;
        gsap.killTweensOf(toolOptions);
        gsap.to(toolOptions, {
            autoAlpha: 0, x: -8, duration: 0.14, ease: 'power1.in',
            onComplete: () => { toolOptions.hidden = true; },
        });
    });

    /* ---------- Grupos de herramientas (un ícono que despliega sus opciones) ---------- */

    const groups = Array.from(document.querySelectorAll('#edit-tools .tool-group'));

    function closeFlyouts(restoreOptions = true) {
        let closed = false;
        groups.forEach(g => {
            const toggle = g.querySelector('.group-toggle');
            const fly = g.querySelector('.group-flyout');
            if (fly.hidden) return;
            closed = true;
            toggle.setAttribute('aria-expanded', 'false');
            gsap.killTweensOf(fly);
            gsap.to(fly, { autoAlpha: 0, x: -8, duration: 0.14, ease: 'power1.in', onComplete: () => { fly.hidden = true; } });
        });
        if (closed && restoreOptions) {
            const checked = document.querySelector('#edit-tools input[name="mode"]:checked');
            if (checked) updateToolOptions(checked);
        }
    }

    function openFlyout(group) {
        const toggle = group.querySelector('.group-toggle');
        const fly = group.querySelector('.group-flyout');
        closeFlyouts(false);
        // Las opciones de color/grosor ceden el lugar mientras se elige la herramienta
        if (!toolOptions.hidden) {
            gsap.killTweensOf(toolOptions);
            toolOptions.hidden = true;
        }
        fly.style.top = `${toggle.offsetTop + toggle.offsetHeight / 2}px`;
        // Celulares (barra fija horizontal): el desplegable se abre hacia abajo, debajo de su botón
        fly.style.left = MOBILE_QUERY.matches ? `${toggle.offsetLeft}px` : '';
        gsap.killTweensOf(fly);
        fly.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        gsap.set(fly, { yPercent: -50 });
        gsap.fromTo(fly, { autoAlpha: 0, x: -8 }, { autoAlpha: 1, x: 0, duration: 0.2, ease: 'power2.out' });
    }

    groups.forEach(group => {
        const toggle = group.querySelector('.group-toggle');
        const fly = group.querySelector('.group-flyout');
        toggle.addEventListener('click', () => {
            if (fly.hidden) openFlyout(group);
            else closeFlyouts();
        });
        // Al elegir una herramienta el grupo muestra su ícono y se cierra
        group.querySelectorAll('input[name="mode"]').forEach(radio => {
            radio.addEventListener('change', () => {
                if (!radio.checked) return;
                const name = radio.closest('.tool').querySelector('svg.ph-icon')?.dataset.iconName;
                if (name && typeof icon === 'function') toggle.innerHTML = icon(name);
                closeFlyouts(false);
            });
        });
    });

    document.addEventListener('pointerdown', e => {
        if (!e.target.closest('.tool-group')) closeFlyouts();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeFlyouts(); });

    /* ---------- Ojo: mostrar / ocultar los menús flotantes ---------- */

    const btnFloating = document.getElementById('btn-toggle-floating');
    const floatingMenus = ['edit-tools', 'side-tools', 'page-nav']
        .map(id => document.getElementById(id))
        .filter(Boolean);

    function setFloatingVisible(show) {
        btnFloating.setAttribute('aria-pressed', String(show));
        btnFloating.title = show ? 'Ocultar los menús flotantes' : 'Mostrar los menús flotantes';
        if (typeof icon === 'function') btnFloating.innerHTML = icon(show ? 'eye' : 'eye-slash');
        document.body.classList.toggle('floating-hidden', !show);
        if (!show) closeFlyouts(false);
        gsap.killTweensOf(floatingMenus, 'opacity,visibility');
        gsap.to(floatingMenus, { autoAlpha: show ? 1 : 0, duration: show ? 0.22 : 0.16, ease: show ? 'power2.out' : 'power1.in' });
    }

    btnFloating.addEventListener('click', () => setFloatingVisible(btnFloating.getAttribute('aria-pressed') !== 'true'));
})();
