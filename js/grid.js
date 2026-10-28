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

        dlg.addEventListener('cancel', e => { e.preventDefault(); this.finish(null); });

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
