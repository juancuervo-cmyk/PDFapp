/**
 * ui-fx.js
 * Capa visual de la interfaz (sin lógica de edición): tooltips propios,
 * luz que sigue al cursor, animaciones de íconos, indicador deslizante de la
 * herramienta activa, entrada de diálogos y detalles de estado. Todo con GSAP.
 */
(function () {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const $ = sel => document.querySelector(sel);

    /* =====================================================================
     * Tooltips: reemplazan el "title" nativo por una burbuja animada que
     * separa el nombre, la descripción y el atajo de teclado.
     * ===================================================================== */

    const tip = document.createElement('div');
    tip.className = 'fx-tooltip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);

    const SHOW_DELAY = 420;
    const WARM_WINDOW = 450;   // tras ocultar uno, el siguiente aparece sin espera
    let tipTarget = null;
    let tipVisible = false;
    let showTimer = null;
    let lastHide = 0;
    let suppressed = null;     // elemento clickeado: no vuelve a mostrar hasta salir

    /** Pasa el title a data-tip (así no aparece el tooltip nativo) y lo devuelve. */
    function tipText(el) {
        const title = el.getAttribute('title');
        if (title) {
            el.dataset.tip = title;
            el.removeAttribute('title');
            if (!el.getAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', title);
        }
        return el.dataset.tip || '';
    }

    function fillTip(text) {
        let head = text;
        let kbd = null;
        let desc = null;
        const m = head.match(/\s*\(((?:Ctrl|Supr|Shift|Alt|Enter|Esc)[^)]*)\)\s*$/i);
        if (m) { kbd = m[1]; head = head.slice(0, m.index); }
        const c = head.indexOf(': ');
        if (c > 0 && c < 32) {
            desc = head.slice(c + 2);
            desc = desc.charAt(0).toUpperCase() + desc.slice(1);
            head = head.slice(0, c);
        }

        tip.textContent = '';
        const headEl = document.createElement('span');
        headEl.className = 'tip-head';
        const label = document.createElement('span');
        label.textContent = head;
        headEl.appendChild(label);
        if (kbd) {
            const k = document.createElement('kbd');
            k.textContent = kbd;
            headEl.appendChild(k);
        }
        tip.appendChild(headEl);
        if (desc) {
            const d = document.createElement('span');
            d.className = 'tip-desc';
            d.textContent = desc;
            tip.appendChild(d);
        }
        const arrow = document.createElement('span');
        arrow.className = 'tip-arrow';
        tip.appendChild(arrow);
    }

    function preferredSide(el) {
        if (el.closest('#tool-options') || el.closest('.group-flyout')) return 'bottom';
        if (el.closest('#edit-tools')) return 'right';
        if (el.closest('#side-tools')) return 'left';
        if (el.closest('#page-nav')) return 'top';
        if (el.closest('.menu-panel')) return 'right';
        if (el.closest('.text-toolbar')) return 'top';
        return 'bottom';
    }

    const OPPOSITE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
    const GAP = 10;
    const MARGIN = 8;

    function computePosition(el, side) {
        const r = el.getBoundingClientRect();
        const w = tip.offsetWidth;
        const h = tip.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        const place = s => {
            switch (s) {
                case 'right': return { x: r.right + GAP, y: r.top + r.height / 2 - h / 2 };
                case 'left': return { x: r.left - GAP - w, y: r.top + r.height / 2 - h / 2 };
                case 'top': return { x: r.left + r.width / 2 - w / 2, y: r.top - GAP - h };
                default: return { x: r.left + r.width / 2 - w / 2, y: r.bottom + GAP };
            }
        };
        const fits = p => p.x >= MARGIN && p.y >= MARGIN && p.x + w <= vw - MARGIN && p.y + h <= vh - MARGIN;

        let pos = place(side);
        if (!fits(pos)) {
            const alt = place(OPPOSITE[side]);
            if (fits(alt)) { pos = alt; side = OPPOSITE[side]; }
        }
        pos.x = Math.min(Math.max(MARGIN, pos.x), vw - w - MARGIN);
        pos.y = Math.min(Math.max(MARGIN, pos.y), vh - h - MARGIN);

        // La flecha apunta al centro del elemento aunque la burbuja se haya corrido
        const arrowX = Math.min(Math.max(12, r.left + r.width / 2 - pos.x), w - 12);
        return { ...pos, side, arrowX };
    }

    function showTip(el) {
        const text = tipText(el);
        if (!text || !el.isConnected) return;
        tipTarget = el;
        fillTip(text);
        const { x, y, side, arrowX } = computePosition(el, preferredSide(el));
        tip.dataset.side = side;
        tip.style.setProperty('--arrow-x', `${arrowX}px`);
        gsap.killTweensOf(tip);

        if (tipVisible && !reduceMotion) {
            // Ya había uno visible: se desliza hasta el nuevo elemento
            gsap.to(tip, { left: x, top: y, x: 0, y: 0, autoAlpha: 1, scale: 1, duration: 0.18, ease: 'power3.out' });
        } else {
            const off = { right: [-6, 0], left: [6, 0], top: [0, 6], bottom: [0, -6] }[side];
            gsap.set(tip, { left: x, top: y, transformOrigin: { right: '0% 50%', left: '100% 50%', top: '50% 100%', bottom: '50% 0%' }[side] });
            gsap.fromTo(tip,
                { autoAlpha: 0, x: off[0], y: off[1], scale: 0.94 },
                { autoAlpha: 1, x: 0, y: 0, scale: 1, duration: reduceMotion ? 0 : 0.2, ease: 'back.out(2)' });
        }
        tipVisible = true;
    }

    function hideTip(immediate = false) {
        clearTimeout(showTimer);
        showTimer = null;
        if (!tipVisible) { tipTarget = null; return; }
        tipVisible = false;
        tipTarget = null;
        lastHide = performance.now();
        gsap.killTweensOf(tip);
        gsap.to(tip, { autoAlpha: 0, scale: 0.97, duration: immediate || reduceMotion ? 0 : 0.1, ease: 'power1.in' });
    }

    function scheduleTip(el) {
        clearTimeout(showTimer);
        const warm = tipVisible || performance.now() - lastHide < WARM_WINDOW;
        if (warm) showTip(el);
        else showTimer = setTimeout(() => showTip(el), SHOW_DELAY);
    }

    document.addEventListener('pointerover', e => {
        if (!(e.target instanceof Element) || e.pointerType === 'touch') return;
        const el = e.target.closest('[title], [data-tip]');
        if (el && el.closest('#print-area')) return;
        if (el === tipTarget && (tipVisible || showTimer)) return;
        if (el && el === suppressed) return;
        suppressed = null;
        if (el) {
            tipText(el);
            if (tipTarget && tipTarget !== el) tipTarget = null;
            tipTarget = el;
            scheduleTip(el);
        } else if (tipTarget || showTimer) {
            hideTip();
        }
    });

    document.addEventListener('pointerout', e => {
        if (!tipTarget) return;
        const to = e.relatedTarget;
        if (to instanceof Element && tipTarget.contains(to)) return;
        if (!to) hideTip();
    });

    document.addEventListener('pointerdown', () => {
        if (tipTarget) suppressed = tipTarget;
        hideTip(true);
    }, true);
    window.addEventListener('wheel', () => hideTip(true), { passive: true, capture: true });
    window.addEventListener('scroll', () => hideTip(true), true);
    window.addEventListener('blur', () => hideTip(true));
    document.addEventListener('keydown', () => hideTip(true), true);
    document.addEventListener('dragstart', () => hideTip(true), true);

    /* =====================================================================
     * Luz que sigue al cursor (botones, herramientas y bordes de las barras)
     * ===================================================================== */

    let glowEvent = null;
    let glowFrame = 0;

    function applyGlow() {
        glowFrame = 0;
        const e = glowEvent;
        if (!e || !(e.target instanceof Element)) return;
        const t = e.target;

        const btn = t.closest('button, .tool, .thumb-item');
        if (btn) {
            const r = btn.getBoundingClientRect();
            btn.style.setProperty('--mx', `${e.clientX - r.left}px`);
            btn.style.setProperty('--my', `${e.clientY - r.top}px`);
        }

        let bar = t.closest('.floating-bar');
        while (bar) {
            const r = bar.getBoundingClientRect();
            bar.style.setProperty('--bar-mx', `${e.clientX - r.left}px`);
            bar.style.setProperty('--bar-my', `${e.clientY - r.top}px`);
            bar = bar.parentElement && bar.parentElement.closest('.floating-bar');
        }

        const top = t.closest('#top-bar');
        if (top) top.style.setProperty('--bar-mx', `${e.clientX - top.getBoundingClientRect().left}px`);
    }

    document.addEventListener('pointermove', e => {
        glowEvent = e;
        if (!glowFrame) glowFrame = requestAnimationFrame(applyGlow);
    }, { passive: true });

    /* =====================================================================
     * Animaciones de íconos al pasar el mouse
     * ===================================================================== */

    function drawIn(svg) {
        const parts = Array.from(svg.querySelectorAll('path, line, polyline, polygon, rect, circle'))
            .filter(p => p.getAttribute('fill') === 'none' && typeof p.getTotalLength === 'function');
        parts.forEach((p, i) => {
            let len = 0;
            try { len = p.getTotalLength(); } catch (_) { return; }
            if (!len) return;
            gsap.fromTo(p,
                { strokeDasharray: len, strokeDashoffset: len },
                { strokeDashoffset: 0, duration: 0.6, delay: i * 0.08, ease: 'power2.inOut', clearProps: 'strokeDasharray,strokeDashoffset' });
        });
    }

    const wiggle = (prop, values, duration = 0.5) => svg =>
        gsap.to(svg, { keyframes: { [prop]: values, easeEach: 'sine.inOut' }, duration });
    const nudge = (vars, duration = 0.22) => svg =>
        gsap.to(svg, { ...vars, duration, ease: 'power2.out', yoyo: true, repeat: 1 });
    const spin = deg => svg =>
        gsap.fromTo(svg, { rotation: 0 }, { rotation: deg, duration: 0.6, ease: 'power3.inOut', clearProps: 'rotation' });
    const pop = (s = 1.16) => svg =>
        gsap.fromTo(svg, { scale: 1 }, { scale: s, duration: 0.14, ease: 'power2.out', yoyo: true, repeat: 1 });

    const ICON_FX = {
        'cursor': nudge({ x: 2, y: 2, rotation: -8 }),
        'text-t': svg => gsap.fromTo(svg, { scaleY: 1 }, { keyframes: { scaleY: [1, 1.22, 0.92, 1], scaleX: [1, 0.9, 1.05, 1] }, duration: 0.45 }),
        'copy-text': nudge({ x: -2, y: -2 }),
        'highlighter': wiggle('rotation', [0, -16, 10, -5, 0]),
        'text-strikethrough': drawIn,
        'text-underline': drawIn,
        'note': drawIn,
        'scribble': drawIn,
        'signature': drawIn,
        'rectangle': drawIn,
        'line-segment': drawIn,
        'check': drawIn,
        'arrow-up-right': nudge({ x: 3, y: -3 }),
        'selection': pop(1.14),
        'crop': spin(90),
        'selection-slash': wiggle('x', [0, -3, 3, -2, 0], 0.4),
        'eraser': wiggle('x', [0, -3, 3, -2, 0], 0.4),
        'magnifying-glass-plus': pop(1.2),
        'magnifying-glass-minus': pop(0.84),
        'arrow-counter-clockwise': spin(-360),
        'arrow-clockwise': spin(360),
        'file-plus': nudge({ y: -3 }),
        'trash': wiggle('rotation', [0, -12, 9, -5, 0], 0.45),
        'caret-left': nudge({ x: -3 }),
        'caret-right': nudge({ x: 3 }),
        'caret-down': nudge({ y: 2 }),
        'moon': wiggle('rotation', [0, -25, 10, 0], 0.6),
        'sun': spin(90),
        'folder-open': nudge({ y: -2, scale: 1.08 }),
        'floppy-disk': nudge({ y: 2, scale: 0.94 }),
        'printer': nudge({ y: -2 }),
        'export': nudge({ y: -3 }),
        'plus-circle': spin(90),
        'scissors': wiggle('rotation', [0, -14, 8, 0], 0.4),
        'squares-four': spin(90),
        'sidebar-simple': nudge({ x: -2 }),
        'dots-six-vertical': nudge({ scaleY: 1.2 }),
        'arrows-out-cardinal': pop(1.2),
    };

    if (!reduceMotion) {
        document.addEventListener('pointerover', e => {
            if (!(e.target instanceof Element)) return;
            const host = e.target.closest('button, .tool, .side-grip, .text-grip');
            if (!host || host.disabled) return;
            if (e.relatedTarget instanceof Element && host.contains(e.relatedTarget)) return;
            const svg = host.querySelector('svg.ph-icon');
            if (!svg || gsap.isTweening(svg)) return;
            const fx = ICON_FX[svg.dataset.iconName] || pop();
            fx(svg);
        });

        // Respuesta táctil al presionar
        const PRESSABLE = '.btn-icon, .tool, .btn-small, .toolbar > button, .menu-trigger, .dialog-buttons button, .grid-buttons button, .signature-chip';
        let pressed = null;
        document.addEventListener('pointerdown', e => {
            if (e.button !== 0 || !(e.target instanceof Element)) return;
            const el = e.target.closest(PRESSABLE);
            if (!el || el.disabled) return;
            pressed = el;
            gsap.to(el, { scale: 0.92, duration: 0.08, ease: 'power2.out', overwrite: 'auto' });
        });
        const release = () => {
            if (!pressed) return;
            gsap.to(pressed, { scale: 1, duration: 0.35, ease: 'back.out(3)', overwrite: 'auto', clearProps: 'scale' });
            pressed = null;
        };
        document.addEventListener('pointerup', release);
        document.addEventListener('pointercancel', release);
    }

    /* =====================================================================
     * Indicador deslizante de la herramienta activa
     * ===================================================================== */

    const editTools = $('#edit-tools');
    const overlay = $('#overlay-canvas');
    if (editTools) {
        const indicator = document.createElement('span');
        indicator.className = 'tool-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        editTools.appendChild(indicator);
        editTools.classList.add('has-indicator');
        let lastTool = null;

        const moveIndicator = (animate = true) => {
            const radio = editTools.querySelector('input[name="mode"]:checked');
            let tool = radio && radio.closest('.tool');
            // Las herramientas agrupadas se marcan sobre el ícono del grupo
            const group = tool && tool.closest('.tool-group');
            if (group) tool = group.querySelector('.group-toggle');
            if (!tool) {
                gsap.to(indicator, { autoAlpha: 0, duration: 0.15 });
                lastTool = null;
                return;
            }
            const pos = { x: tool.offsetLeft, y: tool.offsetTop, width: tool.offsetWidth, height: tool.offsetHeight };
            if (!animate || reduceMotion || !lastTool) {
                gsap.set(indicator, { ...pos, autoAlpha: 1 });
            } else if (tool !== lastTool) {
                gsap.killTweensOf(indicator);
                gsap.timeline()
                    .to(indicator, { ...pos, autoAlpha: 1, duration: 0.42, ease: 'back.out(1.5)' }, 0)
                    .fromTo(indicator, { scaleX: 0.86 }, { scaleX: 1, duration: 0.42, ease: 'elastic.out(1, 0.5)' }, 0.05);
                const svg = tool.querySelector('svg.ph-icon');
                if (svg) gsap.fromTo(svg, { scale: 0.7 }, { scale: 1, duration: 0.45, ease: 'back.out(3)', delay: 0.08 });
            }
            lastTool = tool;
        };

        moveIndicator(false);
        editTools.addEventListener('change', () => moveIndicator(true));
        if (overlay) new MutationObserver(() => moveIndicator(true)).observe(overlay, { attributes: true, attributeFilter: ['data-mode'] });
        window.addEventListener('resize', () => { lastTool = null; moveIndicator(false); });
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { lastTool = null; moveIndicator(false); });
    }

    /* =====================================================================
     * Diálogos: entrada animada al abrir
     * ===================================================================== */

    if (window.HTMLDialogElement) {
        const nativeShowModal = HTMLDialogElement.prototype.showModal;
        HTMLDialogElement.prototype.showModal = function (...args) {
            hideTip(true);
            nativeShowModal.apply(this, args);
            if (reduceMotion) return;
            // Sólo opacidad y variables CSS: si GSAP tocara "transform" en un <dialog> (sin offsetParent)
            // lo reinsertaría en el DOM para medirlo y el diálogo dejaría de ser modal.
            gsap.fromTo(this,
                { opacity: 0, '--dlg-y': '16px', '--dlg-s': 0.96 },
                { opacity: 1, '--dlg-y': '0px', '--dlg-s': 1, duration: 0.32, ease: 'power3.out', clearProps: 'opacity,--dlg-y,--dlg-s' });
            const icon = this.querySelector('.message-icon');
            if (icon) gsap.fromTo(icon, { scale: 0.5, rotation: -20 }, { scale: 1, rotation: 0, duration: 0.5, delay: 0.08, ease: 'back.out(2.5)', clearProps: 'transform' });
        };
    }

    /* =====================================================================
     * Barra de estado: cada mensaje nuevo entra con un pequeño fundido
     * ===================================================================== */

    const statusBar = $('#status-bar');
    if (statusBar && !reduceMotion) {
        new MutationObserver(() => {
            if (!statusBar.textContent.trim()) return;
            gsap.fromTo(statusBar, { opacity: 0.25 }, { opacity: 1, duration: 0.4, ease: 'power2.out', clearProps: 'opacity' });
            const svg = statusBar.querySelector('svg.ph-icon');
            if (svg) gsap.fromTo(svg, { scale: 0.4, rotation: -30 }, { scale: 1, rotation: 0, duration: 0.45, ease: 'back.out(2.5)' });
        }).observe(statusBar, { childList: true });
    }

    /* =====================================================================
     * Miniaturas: aparecen en cascada al cargar un documento
     * ===================================================================== */

    const thumbList = $('#thumbnail-list');
    if (thumbList && !reduceMotion) {
        let prevCount = thumbList.children.length;
        new MutationObserver(() => {
            const count = thumbList.children.length;
            if (prevCount === 0 && count > 0) {
                gsap.fromTo(Array.from(thumbList.children).slice(0, 10),
                    { autoAlpha: 0, y: 14 },
                    { autoAlpha: 1, y: 0, duration: 0.35, ease: 'power2.out', stagger: 0.04, clearProps: 'opacity,visibility,transform' });
            }
            prevCount = count;
        }).observe(thumbList, { childList: true });
    }

    /* =====================================================================
     * Página: aparece suave la primera vez que se muestra
     * ===================================================================== */

    const pageWrapper = $('#page-wrapper');
    const placeholder = $('#page-placeholder');
    if (pageWrapper && !reduceMotion) {
        new MutationObserver(() => {
            if (!pageWrapper.hidden) {
                gsap.fromTo(pageWrapper, { autoAlpha: 0, y: 18, scale: 0.985 },
                    { autoAlpha: 1, y: 0, scale: 1, duration: 0.45, ease: 'power3.out', clearProps: 'opacity,visibility,transform' });
            }
        }).observe(pageWrapper, { attributes: true, attributeFilter: ['hidden'] });
    }

    /* =====================================================================
     * Zona para soltar archivos: se ilumina al arrastrar archivos encima
     * ===================================================================== */

    let filesOverTimer = null;
    window.addEventListener('dragover', e => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
        if (!document.body.classList.contains('files-over')) {
            document.body.classList.add('files-over');
            const icon = $('.drop-icon');
            if (icon && !reduceMotion) gsap.to(icon, { scale: 1.12, duration: 0.3, ease: 'back.out(2)' });
        }
        clearTimeout(filesOverTimer);
        filesOverTimer = setTimeout(clearFilesOver, 150);
    });
    window.addEventListener('drop', () => clearFilesOver());

    function clearFilesOver() {
        clearTimeout(filesOverTimer);
        if (!document.body.classList.contains('files-over')) return;
        document.body.classList.remove('files-over');
        const icon = $('.drop-icon');
        if (icon && !reduceMotion) gsap.to(icon, { scale: 1, duration: 0.3, ease: 'power2.out' });
    }

    /* =====================================================================
     * Cambio de tema: el ícono nuevo entra girando
     * ===================================================================== */

    const btnTheme = $('#btn-theme');
    if (btnTheme && !reduceMotion) {
        btnTheme.addEventListener('click', () => {
            const svg = btnTheme.querySelector('svg.ph-icon');
            if (svg) gsap.fromTo(svg, { rotation: -120, scale: 0.3 }, { rotation: 0, scale: 1, duration: 0.55, ease: 'back.out(2)' });
        });
    }

    /* =====================================================================
     * Entrada inicial de la interfaz
     * ===================================================================== */

    const pageNav = $('#page-nav');
    // La paginación se centra con xPercent para que GSAP no fije el centrado en px
    if (pageNav) gsap.set(pageNav, { x: 0, xPercent: -50 });

    if (!reduceMotion) {
        const intro = gsap.timeline({ defaults: { ease: 'power3.out' } });
        intro
            .from('#top-bar > *', { autoAlpha: 0, y: -8, duration: 0.4, stagger: 0.04, clearProps: 'opacity,visibility,transform' }, 0)
            .from(['#thumbnail-list', '#scroll-area'], { autoAlpha: 0, duration: 0.5, stagger: 0.06, clearProps: 'opacity,visibility' }, 0.05)
            .from('#edit-tools', { autoAlpha: 0, x: -18, duration: 0.5 }, 0.15)
            .from('#side-tools', { autoAlpha: 0, x: 18, duration: 0.5 }, 0.18)
            .from('#page-nav', { autoAlpha: 0, y: 18, duration: 0.5 }, 0.22)
            .from('#edit-tools > .tool, #edit-tools > .tool-group > .group-toggle, #side-tools > .btn-icon', { autoAlpha: 0, scale: 0.6, duration: 0.35, stagger: 0.02, ease: 'back.out(2)', clearProps: 'opacity,visibility,transform' }, 0.25);

        if (placeholder && !placeholder.hidden) {
            intro.from(placeholder, { autoAlpha: 0, y: 20, scale: 0.97, duration: 0.6, clearProps: 'opacity,visibility,transform' }, 0.1);
            const dropIcon = placeholder.querySelector('.drop-icon svg');
            if (dropIcon) gsap.to(dropIcon, { y: -5, duration: 1.6, ease: 'sine.inOut', yoyo: true, repeat: -1 });
        }
    }
})();
