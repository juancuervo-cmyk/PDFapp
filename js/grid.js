/* =========================================================================
 * grid.js
 * Equivalente a GridViewDialog + GridListWidget: organizador visual de
 * páginas en cuadrícula con mover ◀/▶ o arrastrar y soltar, eliminar (Supr), deshacer (Ctrl+Z),
 * zoom de miniaturas (Ctrl+Rueda / botones) y Guardar Cambios / Cancelar.
 * Devuelve el nuevo orden de páginas (índices originales) o null.
 * ========================================================================= */

class GridViewDialog {
    constructor(pdfJsDoc) {
        this.pdfDoc = pdfJsDoc;
        this.history = [];
        // Proporción base vertical para las miniaturas
        this.iconWidth = 150;
        this.iconHeight = 205;
        this.items = [];          // índices de página originales, en el orden actual
        this.currentRow = -1;
        this.selected = new Set(); // filas seleccionadas (varias con Ctrl/Mayús + clic)
        this.canvases = new Map(); // página original -> canvas renderizado
        this.renderToken = 0;
        this.dragFrom = null;      // fila que se está arrastrando
        this.dropIndex = null;     // posición de inserción durante el arrastre
        this.previewEl = null;     // página ampliada al 100 % (doble clic)
        this.previewToken = 0;
        this.preview = null;       // estado del zoom de la página ampliada (Ctrl++ / Ctrl+-)
        this.previewPointer = null;
        // Teclado con la página ampliada. Se escucha en toda la ventana (fase de captura) para que
        // Ctrl++ / Ctrl+- agranden sólo la página aunque el foco haya quedado fuera del diálogo;
        // si no, el navegador haría zoom de toda la ventana. No se edita la cuadrícula: sólo Esc y zoom.
        this.onPreviewKeyDown = e => {
            e.preventDefault();
            e.stopPropagation();
            const ctrl = e.ctrlKey || e.metaKey;
            if (e.key === 'Escape') this.closePagePreview();
            else if (ctrl && (e.key === '+' || e.key === '=')) this.zoomPreview(1.25);
            else if (ctrl && e.key === '-') this.zoomPreview(0.8);
        };
        // Ctrl+Rueda (y el pellizco del touchpad, que llega igual) también agranda sólo la página
        this.onPreviewWheel = e => {
            if (!e.ctrlKey) return; // sin Ctrl la rueda desplaza la página ampliada
            e.preventDefault();
            e.stopPropagation();
            this.previewPointer = { x: e.clientX, y: e.clientY };
            const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY; // Firefox informa en líneas
            if (delta) this.zoomPreview(Math.pow(1.25, -delta / 100)); // una muesca = un Ctrl++
        };
    }

    open() {
        return new Promise(resolve => {
            this.resolve = resolve;
            this.build();
            this.populateGrid();
            this.dlg.showModal();
            this.gridEl.focus();
        });
    }

    build() {
        const dlg = document.createElement('dialog');
        dlg.className = 'qt-dialog grid-dialog';
        dlg.innerHTML = `
            <div class="dialog-title">Organizador Visual - Vista en Cuadrícula</div>
            <div class="grid-info"><b>Selecciona una página y usa ${icon("caret-left")} / ${icon("caret-right")} (o arrástrala) para intercalarla. Ctrl+clic o Mayús+clic seleccionan varias (Ctrl+A: todas), Supr para eliminarlas, Ctrl+Z para deshacer o Ctrl+Rueda para hacer Zoom.</b></div>
            <div class="grid-list" tabindex="0"></div>
            <div class="grid-buttons">
                <button type="button" data-act="left">${icon("caret-left")} Mover Izquierda</button>
                <button type="button" data-act="right">Mover Derecha ${icon("caret-right")}</button>
                <span class="spacer-10"></span>
                <button type="button" data-act="zoom-out" class="grid-icon-btn" title="Reducir miniaturas (Ctrl+Rueda)">${icon("magnifying-glass-minus")}</button>
                <button type="button" data-act="zoom-in" class="grid-icon-btn" title="Ampliar miniaturas (Ctrl+Rueda)">${icon("magnifying-glass-plus")}</button>
                <span class="spacer-10"></span>
                <button type="button" data-act="undo">${icon("arrow-counter-clockwise")} Deshacer</button>
                <button type="button" data-act="delete" class="grid-icon-btn" title="Eliminar páginas seleccionadas (Supr)">${icon("trash")}</button>
                <span class="stretch"></span>
                <button type="button" data-act="ok" class="default">Guardar Cambios</button>
                <button type="button" data-act="cancel">Cancelar</button>
            </div>
            <span class="grid-resize-grip" title="Arrastra para cambiar el tamaño de la ventana"></span>
        `;
        document.body.appendChild(dlg);
        this.dlg = dlg;
        this.gridEl = dlg.querySelector('.grid-list');

        const actions = {
            left: () => this.moveItemLeft(),
            right: () => this.moveItemRight(),
            'zoom-out': () => this.zoomGrid(0.85),
            'zoom-in': () => this.zoomGrid(1.15),
            undo: () => this.undoGridAction(),
            delete: () => this.deleteSelectedItem(),
            ok: () => this.finish(this.items.slice()),
            cancel: () => this.finish(null)
        };
        dlg.querySelectorAll('.grid-buttons button').forEach(btn => {
            btn.addEventListener('click', () => {
                actions[btn.dataset.act]();
                if (btn.dataset.act !== 'ok' && btn.dataset.act !== 'cancel') this.gridEl.focus();
            });
        });

        dlg.addEventListener('cancel', e => {
            e.preventDefault();
            if (this.previewEl) this.closePagePreview(); // Esc con la página ampliada: vuelve a la cuadrícula
            else this.finish(null);
        });

        // Redimensionar la ventana desde la esquina. El diálogo está centrado, así que
        // crece el doble de lo que se mueve el mouse para que la esquina lo siga.
        const grip = dlg.querySelector('.grid-resize-grip');
        grip.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.preventDefault();
            const startX = e.clientX, startY = e.clientY;
            const startW = dlg.offsetWidth, startH = dlg.offsetHeight;
            grip.setPointerCapture(e.pointerId);
            document.body.classList.add('resizing-grid');
            const onMove = ev => {
                const w = Math.min(window.innerWidth * 0.95, Math.max(560, startW + (ev.clientX - startX) * 2));
                const h = Math.min(window.innerHeight * 0.95, Math.max(420, startH + (ev.clientY - startY) * 2));
                dlg.style.width = `${w}px`;
                dlg.style.height = `${h}px`;
            };
            const onUp = () => {
                document.body.classList.remove('resizing-grid');
                grip.removeEventListener('pointermove', onMove);
                grip.removeEventListener('pointerup', onUp);
                grip.removeEventListener('pointercancel', onUp);
                this.scrollCurrentIntoView();
            };
            grip.addEventListener('pointermove', onMove);
            grip.addEventListener('pointerup', onUp);
            grip.addEventListener('pointercancel', onUp);
        });

        dlg.addEventListener('keydown', e => {
            if (e.target.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;
            const ctrl = e.ctrlKey || e.metaKey;
            if (ctrl && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                this.undoGridAction();
            } else if (ctrl && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                this.selected = new Set(this.items.keys());
                this.updateSelectionClasses();
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                this.deleteSelectedItem();
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                this.moveItemLeft();
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                this.moveItemRight();
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                this.moveSelectionVertically(e.key === 'ArrowUp' ? -1 : 1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                this.finish(this.items.slice());
            }
        });

        this.gridEl.addEventListener('wheel', e => {
            if (e.ctrlKey) {
                e.preventDefault();
                if (e.deltaY < 0) this.zoomGrid(1.2);        // Ampliar miniaturas
                else if (e.deltaY > 0) this.zoomGrid(0.8);   // Reducir miniaturas
            }
        }, { passive: false });

        this.gridEl.addEventListener('dragover', e => this.onDragOver(e));
        this.gridEl.addEventListener('dragleave', e => {
            if (!this.gridEl.contains(e.relatedTarget)) this.clearDropMarker();
        });
        this.gridEl.addEventListener('drop', e => {
            e.preventDefault();
            const from = this.dragFrom;
            const to = this.dropIndex;
            this.clearDropMarker();
            if (from !== null && to !== null) this.moveItemTo(from, to);
        });

        // Archivos arrastrados desde afuera: no se pueden cargar en este modo
        const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
        this.dlg.addEventListener('dragover', e => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'none';
        });
        this.dlg.addEventListener('drop', e => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            msgWarning('Aviso', 'No es posible arrastrar documentos en el modo cuadrícula. Cierra esta vista para abrir o combinar archivos.');
        });
    }

    /** Calcula dónde se insertaría la página arrastrada y muestra el indicador. */
    onDragOver(e) {
        if (this.dragFrom === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        // Auto-desplazamiento cerca de los bordes superior/inferior
        const listRect = this.gridEl.getBoundingClientRect();
        const edge = 40;
        if (e.clientY < listRect.top + edge) this.gridEl.scrollTop -= 15;
        else if (e.clientY > listRect.bottom - edge) this.gridEl.scrollTop += 15;

        const cells = this.gridEl.children;
        const cell = e.target.closest('.grid-item');
        let index, marker, before;
        if (cell && this.gridEl.contains(cell)) {
            const rect = cell.getBoundingClientRect();
            before = e.clientX < rect.left + rect.width / 2;
            const idx = Array.prototype.indexOf.call(cells, cell);
            index = before ? idx : idx + 1;
            marker = cell;
        } else {
            // Espacio vacío de la cuadrícula: se inserta al final
            index = this.items.length;
            marker = cells[cells.length - 1];
            before = false;
        }
        if (index === this.dropIndex) return;
        this.clearDropMarker();
        this.dropIndex = index;
        if (marker) marker.classList.add(before ? 'drop-before' : 'drop-after');
    }

    clearDropMarker() {
        this.dropIndex = null;
        this.gridEl.querySelectorAll('.drop-before, .drop-after')
            .forEach(el => el.classList.remove('drop-before', 'drop-after'));
    }

    /** Mueve la página de la fila `from` para insertarla antes de la posición `to`. */
    moveItemTo(from, to) {
        if (from < 0 || from >= this.items.length) return;
        // Si la página arrastrada forma parte de la selección, se mueve todo el grupo
        const rows = this.selected.has(from) ? [...this.selected] : [from];
        this.moveRowsTo(rows, to);
        this.gridEl.focus();
    }

    /** Mueve las filas indicadas, juntas y en su orden, para insertarlas antes de la posición `to` (índice original). */
    moveRowsTo(rows, to) {
        rows = [...new Set(rows)].filter(r => r >= 0 && r < this.items.length).sort((a, b) => a - b);
        if (!rows.length) return false;
        const set = new Set(rows);
        const moved = rows.map(r => this.items[r]);
        const rest = this.items.filter((_, i) => !set.has(i));
        const insertAt = to - rows.filter(r => r < to).length;
        const next = rest.slice(0, insertAt).concat(moved, rest.slice(insertAt));
        if (next.every((p, i) => p === this.items[i])) return false;
        this.saveGridState();
        this.items = next;
        this.selected = new Set(moved.map((_, i) => insertAt + i));
        this.currentRow = insertAt + moved.length - 1;
        this.refresh();
        return true;
    }

    finish(result) {
        this.renderToken++;
        window.removeEventListener('keydown', this.onPreviewKeyDown, true);
        window.removeEventListener('wheel', this.onPreviewWheel, { capture: true });
        if (this.dlg.open) this.dlg.close();
        this.dlg.remove();
        this.resolve(result);
    }

    populateGrid() {
        this.items = [];
        for (let i = 0; i < this.pdfDoc.numPages; i++) this.items.push(i);
        this.currentRow = this.items.length > 0 ? 0 : -1;
        this.selected = new Set(this.currentRow >= 0 ? [0] : []);
        this.renderThumbnails();
        this.refresh();
    }

    /** Renderiza las miniaturas con resolución adaptativa según el zoom actual. */
    async renderThumbnails() {
        const token = ++this.renderToken;
        const thumbZoom = Math.max(0.2, this.iconWidth / 200.0);
        const dpr = window.devicePixelRatio || 1;
        for (const pageIndex of [...new Set(this.items)]) {
            if (token !== this.renderToken) return;
            const page = await this.pdfDoc.getPage(pageIndex + 1);
            const viewport = page.getViewport({ scale: thumbZoom * dpr });
            const canvas = document.createElement('canvas');
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            if (token !== this.renderToken) return;
            const old = this.canvases.get(pageIndex);
            this.canvases.set(pageIndex, canvas);
            if (old && old.parentNode) {
                old.parentNode.replaceChild(canvas, old);
            } else {
                const box = this.gridEl.querySelector(`.grid-icon[data-page="${pageIndex}"]`);
                if (box) box.appendChild(canvas);
            }
        }
    }

    /** Redibuja la cuadrícula (etiquetas 1..N reindexadas, selección y tamaños de celda). */
    refresh() {
        const w = Math.round(this.iconWidth);
        const h = Math.round(this.iconHeight);
        this.gridEl.style.setProperty('--icon-w', `${w}px`);
        this.gridEl.style.setProperty('--icon-h', `${h}px`);
        this.gridEl.innerHTML = '';
        this.items.forEach((pageIndex, row) => {
            const cell = document.createElement('div');
            cell.className = 'grid-item' + (this.selected.has(row) ? ' selected' : '');
            const iconBox = document.createElement('div');
            iconBox.className = 'grid-icon';
            iconBox.dataset.page = String(pageIndex);
            const canvas = this.canvases.get(pageIndex);
            if (canvas) iconBox.appendChild(canvas);
            const label = document.createElement('div');
            label.className = 'grid-label';
            label.textContent = String(row + 1);
            cell.append(iconBox, label);
            cell.addEventListener('mousedown', e => this.onCellMouseDown(e, row));
            cell.addEventListener('dblclick', () => this.openPagePreview(pageIndex));
            cell.draggable = true;
            cell.addEventListener('dragstart', e => {
                this.dragFrom = row;
                if (!this.selected.has(row)) this.setCurrentRow(row);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(row));
                cell.classList.add('dragging');
            });
            cell.addEventListener('dragend', () => {
                this.dragFrom = null;
                cell.classList.remove('dragging');
                this.clearDropMarker();
            });
            this.gridEl.appendChild(cell);
        });
        this.scrollCurrentIntoView();
    }

    /** Doble clic: muestra la página ocupando toda la ventana. Doble clic, Esc o la X vuelven a la cuadrícula. */
    async openPagePreview(pageIndex) {
        if (this.previewEl) return;
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const overlay = document.createElement('div');
        overlay.className = 'grid-preview';
        overlay.innerHTML = `
            <div class="grid-preview-scroll"><div class="grid-preview-stage"></div></div>
            <button type="button" class="btn-icon grid-preview-close" title="Volver a la cuadrícula (Esc)">${icon('x')}</button>`;
        overlay.addEventListener('dblclick', () => this.closePagePreview());
        overlay.querySelector('.grid-preview-close').addEventListener('click', () => this.closePagePreview());
        const scroller = overlay.querySelector('.grid-preview-scroll');
        const stage = overlay.querySelector('.grid-preview-stage');
        // Última posición del mouse: el zoom con Ctrl++ / Ctrl+- se centra en ese punto de la página
        this.previewPointer = null;
        scroller.addEventListener('pointermove', e => { this.previewPointer = { x: e.clientX, y: e.clientY }; });
        scroller.addEventListener('pointerleave', () => { this.previewPointer = null; });
        this.dlg.appendChild(overlay);
        this.previewEl = overlay;
        window.addEventListener('keydown', this.onPreviewKeyDown, true);
        window.addEventListener('wheel', this.onPreviewWheel, { capture: true, passive: false });
        gsap.fromTo(overlay, { autoAlpha: 0 }, { autoAlpha: 1, duration: reduceMotion ? 0 : 0.2, ease: 'power2.out' });

        // Tamaño inicial: la página entera ocupando el área disponible
        const token = ++this.previewToken;
        const page = await this.pdfDoc.getPage(pageIndex + 1);
        if (token !== this.previewToken) return;
        const base = page.getViewport({ scale: 1 });
        const style = getComputedStyle(stage);
        const availW = scroller.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const availH = scroller.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
        const fit = Math.min(availW / base.width, availH / base.height);
        const canvas = document.createElement('canvas');
        this.preview = { page, canvas, scroller, fit, baseW: base.width * fit, baseH: base.height * fit, zoom: 1, targetZoom: 1 };
        this.applyPreviewZoom();
        await this.renderPreview();
        if (token !== this.previewToken) return;
        stage.appendChild(canvas);
        gsap.fromTo(canvas, { autoAlpha: 0, scale: 0.94 },
            { autoAlpha: 1, scale: 1, duration: reduceMotion ? 0 : 0.3, ease: 'power3.out', clearProps: 'transform' });
    }

    /** Renderiza la página ampliada a la resolución del zoom actual para que se vea nítida. */
    async renderPreview() {
        const p = this.preview;
        if (!p) return;
        const zoom = p.zoom;
        const base = p.page.getViewport({ scale: 1 });
        // Tope de píxeles del lienzo para no agotar la memoria con zoom muy alto
        const maxScale = Math.sqrt(32e6 / (base.width * base.height));
        const viewport = p.page.getViewport({ scale: Math.min(p.fit * zoom * (window.devicePixelRatio || 1), maxScale) });
        const off = document.createElement('canvas');
        off.width = Math.floor(viewport.width);
        off.height = Math.floor(viewport.height);
        await p.page.render({ canvasContext: off.getContext('2d'), viewport }).promise;
        if (this.preview !== p || p.zoom !== zoom) return; // ya hay otro zoom en curso: lo renderiza ese
        p.canvas.width = off.width;
        p.canvas.height = off.height;
        p.canvas.getContext('2d').drawImage(off, 0, 0);
    }

    /** Ctrl++ / Ctrl+-: agranda o achica la página ampliada manteniendo fijo el punto bajo el mouse. */
    zoomPreview(factor) {
        const p = this.preview;
        if (!p || !p.canvas.isConnected) return;
        const target = Math.min(8, Math.max(0.25, p.targetZoom * factor));
        if (target === p.targetZoom) return;
        p.targetZoom = target;

        // Punto de anclaje: el lugar de la página bajo el mouse (o el centro de la vista si no está encima)
        const rect = p.scroller.getBoundingClientRect();
        const ptr = this.previewPointer;
        const mx = ptr ? ptr.x - rect.left : p.scroller.clientWidth / 2;
        const my = ptr ? ptr.y - rect.top : p.scroller.clientHeight / 2;
        const clamp01 = v => Math.min(1, Math.max(0, v));
        const anchor = {
            fx: clamp01((p.scroller.scrollLeft + mx - p.canvas.offsetLeft) / (p.baseW * p.zoom)),
            fy: clamp01((p.scroller.scrollTop + my - p.canvas.offsetTop) / (p.baseH * p.zoom)),
            mx, my
        };

        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        gsap.killTweensOf(p);
        gsap.to(p, {
            zoom: target,
            duration: reduceMotion ? 0 : 0.2,
            ease: 'power2.out',
            onUpdate: () => this.applyPreviewZoom(anchor),
            onComplete: () => { this.applyPreviewZoom(anchor); this.renderPreview(); }
        });
    }

    applyPreviewZoom(anchor = null) {
        const p = this.preview;
        if (!p) return;
        const w = p.baseW * p.zoom;
        const h = p.baseH * p.zoom;
        p.canvas.style.width = `${w}px`;
        p.canvas.style.height = `${h}px`;
        if (anchor) {
            p.scroller.scrollLeft = p.canvas.offsetLeft + anchor.fx * w - anchor.mx;
            p.scroller.scrollTop = p.canvas.offsetTop + anchor.fy * h - anchor.my;
        }
    }

    closePagePreview() {
        const overlay = this.previewEl;
        if (!overlay) return;
        window.removeEventListener('keydown', this.onPreviewKeyDown, true);
        window.removeEventListener('wheel', this.onPreviewWheel, { capture: true });
        if (this.preview) gsap.killTweensOf(this.preview);
        this.preview = null;
        this.previewPointer = null;
        this.previewEl = null;
        this.previewToken++;
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        gsap.to(overlay, { autoAlpha: 0, duration: reduceMotion ? 0 : 0.15, ease: 'power1.in', onComplete: () => overlay.remove() });
        this.gridEl.focus();
    }

    setCurrentRow(row) {
        this.currentRow = row;
        this.selected = new Set(row >= 0 ? [row] : []);
        this.updateSelectionClasses();
    }

    updateSelectionClasses() {
        this.gridEl.querySelectorAll('.grid-item').forEach((el, i) => el.classList.toggle('selected', this.selected.has(i)));
    }

    /** Clic: selecciona una; Ctrl+clic suma/quita; Mayús+clic selecciona el rango desde la actual. */
    onCellMouseDown(e, row) {
        if (e.shiftKey && this.currentRow >= 0) {
            const [a, b] = [Math.min(this.currentRow, row), Math.max(this.currentRow, row)];
            this.selected = new Set();
            for (let i = a; i <= b; i++) this.selected.add(i);
            e.preventDefault(); // evita seleccionar texto
            this.updateSelectionClasses();
        } else if (e.ctrlKey || e.metaKey) {
            if (this.selected.has(row) && this.selected.size > 1) this.selected.delete(row);
            else this.selected.add(row);
            this.currentRow = row;
            this.updateSelectionClasses();
        } else if (!this.selected.has(row)) {
            this.setCurrentRow(row);
        } else {
            // Clic en una ya seleccionada: se conserva el grupo (por si se va a arrastrar)
            this.currentRow = row;
        }
    }

    scrollCurrentIntoView() {
        const el = this.gridEl.children[this.currentRow];
        if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    columnCount() {
        const first = this.gridEl.children[0];
        if (!first) return 1;
        const top = first.offsetTop;
        let cols = 0;
        for (const el of this.gridEl.children) {
            if (el.offsetTop !== top) break;
            cols++;
        }
        return Math.max(1, cols);
    }

    moveSelectionVertically(dir) {
        if (this.currentRow < 0) return;
        const next = this.currentRow + dir * this.columnCount();
        if (next >= 0 && next < this.items.length) {
            this.setCurrentRow(next);
            this.scrollCurrentIntoView();
        }
    }

    zoomGrid(factor) {
        const newW = this.iconWidth * factor;
        const newH = this.iconHeight * factor;
        if (newW >= 60 && newW <= 1200) {
            this.iconWidth = newW;
            this.iconHeight = newH;
            this.refresh();
            // Se re-renderizan las imágenes en alta calidad al hacer zoom
            this.renderThumbnails();
        }
    }

    saveGridState() {
        this.history.push({ items: this.items.slice(), row: this.currentRow });
    }

    undoGridAction() {
        if (!this.history.length) return;
        const prev = this.history.pop();
        this.items = prev.items;
        this.currentRow = prev.row >= 0 && prev.row < this.items.length ? prev.row : -1;
        this.selected = new Set(this.currentRow >= 0 ? [this.currentRow] : []);
        this.refresh();
    }

    moveItemLeft() {
        const rows = this.selected.size ? [...this.selected] : [this.currentRow];
        const min = Math.min(...rows);
        if (min > 0) this.moveRowsTo(rows, min - 1);
    }

    moveItemRight() {
        if (this.currentRow < 0) return;
        const rows = this.selected.size ? [...this.selected] : [this.currentRow];
        const max = Math.max(...rows);
        if (max < this.items.length - 1) this.moveRowsTo(rows, max + 2);
    }

    async deleteSelectedItem() {
        if (this.currentRow < 0) return;
        const rows = [...this.selected].sort((a, b) => a - b);
        if (!rows.length) rows.push(this.currentRow);
        if (rows.length >= this.items.length) {
            await msgWarning('Aviso', this.items.length <= 1
                ? 'No se puede eliminar la única página del documento.'
                : 'No se pueden eliminar todas las páginas del documento.');
            this.gridEl.focus();
            return;
        }
        this.saveGridState();
        for (let i = rows.length - 1; i >= 0; i--) this.items.splice(rows[i], 1);
        this.currentRow = Math.min(rows[0], this.items.length - 1);
        this.selected = new Set([this.currentRow]);
        this.refresh();
    }
}
