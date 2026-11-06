/* =========================================================================
 * split.js
 * Ventana "Dividir": muestra el documento abierto (o un espacio para cargar
 * uno) y permite armar divisiones. Cada división tiene la vista previa de su
 * primera y última hoja, los campos Desde / Hasta y el rango libre
 * ("1-21, 3, 4, 8"). Con + se agrega otra división
 * que arranca en la hoja siguiente a la anterior. Doble clic en una vista
 * previa muestra en cuadrícula todas las hojas de esa división.
 * Abajo siempre hay un espacio para cargar otro PDF y dividirlo también.
 * Descargar separados / Descargar ZIP: un PDF por división; la ventana sigue abierta.
 * Unir: pasa a una vista donde las partes se ordenan arrastrándolas; Aceptar
 * las une en ese orden y abre el resultado en el lector.
 * Devuelve { bytes, name } para abrir en el lector, o null.
 * ========================================================================= */

/** Rango escrito -> índices de página (base 0). Lanza un error si no es válido o queda vacío. */
function parseDivisionRange(text, total) {
    const pages = parsePageRange(text, total);
    if (!pages.length) throw new Error('vacío');
    return pages;
}

class SplitDialog {
    /** `current` = { name, bytes } del documento abierto (opcional). */
    constructor(current = null) {
        this.docs = [];   // { id, name, bytes, pdf, pages, thumbs: Map, divisions: [{ id, text }], error }
        this.nextId = 1;
        this.busy = false;
        this.loading = 0;
        this.gridEl = null;
        this.gridToken = 0;
        this.mode = 'edit';  // 'edit': armar divisiones · 'order': ordenar las partes antes de unir
        this.order = [];     // ids de división en el orden elegido para unir
        this.dragId = null;
        if (current) this.docs.push(this.newDoc(current.name, current.bytes));
        this.fileInput = document.createElement('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.pdf,application/pdf';
        this.fileInput.multiple = true;
        this.fileInput.hidden = true;
        this.fileInput.addEventListener('change', () => {
            const files = Array.from(this.fileInput.files);
            this.fileInput.value = '';
            if (files.length) this.addFiles(files);
        });
    }

    newDoc(name, bytes) {
        return { id: this.nextId++, name, bytes, pdf: null, pages: 0, thumbs: new Map(), divisions: [], error: false };
    }

    open() {
        return new Promise(resolve => {
            this.resolve = resolve;
            this.build();
            this.render();
            this.dlg.showModal();
            this.docs.forEach(doc => this.prepareDoc(doc));
        });
    }

    build() {
        const dlg = document.createElement('dialog');
        dlg.className = 'qt-dialog split-dialog';
        dlg.innerHTML = `
            <div class="dialog-title merge-title">
                <span>Dividir PDF</span>
                <button type="button" class="btn-icon merge-close" title="Cerrar (Esc)">${icon('x')}</button>
            </div>
            <div class="merge-info"></div>
            <div class="split-list"></div>
            <div class="dialog-buttons merge-buttons">
                <span class="merge-status" aria-live="polite"></span>
                <button type="button" data-act="separate" class="default">${icon('download-simple')} Descargar separados</button>
                <button type="button" data-act="zip" class="default">${icon('file-zip')} Descargar ZIP</button>
                <button type="button" data-act="back">${icon('caret-left')} Volver</button>
                <button type="button" data-act="join">${icon('arrows-merge')} Unir</button>
            </div>
        `;
        dlg.appendChild(this.fileInput);
        document.body.appendChild(dlg);
        this.dlg = dlg;
        this.infoEl = dlg.querySelector('.merge-info');
        this.listEl = dlg.querySelector('.split-list');
        this.statusEl = dlg.querySelector('.merge-status');
        this.btnSeparate = dlg.querySelector('[data-act="separate"]');
        this.btnZip = dlg.querySelector('[data-act="zip"]');
        this.btnBack = dlg.querySelector('[data-act="back"]');
        this.btnJoin = dlg.querySelector('[data-act="join"]');

        dlg.querySelector('.merge-close').addEventListener('click', () => { if (!this.busy) this.finish(null); });
        this.btnSeparate.addEventListener('click', () => this.downloadSeparate());
        this.btnZip.addEventListener('click', () => this.downloadZip());
        this.btnBack.addEventListener('click', () => this.setMode('edit'));
        this.btnJoin.addEventListener('click', () => (this.mode === 'order' ? this.acceptJoin() : this.setMode('order')));

        dlg.addEventListener('cancel', e => {
            e.preventDefault();
            if (this.gridEl) this.closeGrid();
            else if (this.busy) return;
            else if (this.mode === 'order') this.setMode('edit');
            else this.finish(null);
        });

        // Archivos soltados en cualquier parte de la ventana se agregan al final (no mientras se ordena)
        const isFileDrag = e => this.mode === 'edit' && e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
        dlg.addEventListener('dragover', e => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            dlg.classList.add('file-over');
        });
        dlg.addEventListener('dragleave', e => {
            if (!dlg.contains(e.relatedTarget)) dlg.classList.remove('file-over');
        });
        dlg.addEventListener('drop', e => {
            dlg.classList.remove('file-over');
            if (!isFileDrag(e)) return;
            e.preventDefault();
            this.addFiles(Array.from(e.dataTransfer.files));
        });
    }

    async prepareDoc(doc) {
        try {
            doc.pdf = await pdfjsLib.getDocument({
                data: doc.bytes.slice(),
                cMapUrl: `${PDFJS_ASSETS}cmaps/`,
                cMapPacked: true,
                standardFontDataUrl: `${PDFJS_ASSETS}standard_fonts/`
            }).promise;
            doc.pages = doc.pdf.numPages;
            doc.divisions = [{ id: this.nextId++, text: doc.pages > 1 ? `1-${doc.pages}` : '1' }];
        } catch (e) {
            console.error(e);
            doc.error = true;
        }
        if (this.docs.includes(doc)) this.render();
    }

    async addFiles(files) {
        if (this.busy) return;
        const pdfs = files.filter(f => isPdfName(f.name));
        const skipped = files.length - pdfs.length;
        this.loading += pdfs.length;
        this.render();
        for (const file of pdfs) {
            const doc = this.newDoc(file.name, await readFileBytes(file));
            this.loading -= 1;
            this.docs.push(doc);
            this.render();
            this.prepareDoc(doc);
        }
        if (skipped) this.setStatus(`Se ignoraron ${skipped} archivo(s) que no son PDF.`);
    }

    removeDoc(doc) {
        if (this.busy) return;
        this.docs = this.docs.filter(d => d !== doc);
        if (doc.pdf) doc.pdf.destroy();
        this.render();
    }

    /** Agrega una división que empieza en la hoja siguiente a la última dividida y termina al final. */
    addDivision(doc) {
        let lastEnd = 0;
        for (const div of doc.divisions) {
            try {
                const pages = parseDivisionRange(div.text, doc.pages);
                lastEnd = Math.max(lastEnd, pages[pages.length - 1] + 1);
            } catch (e) { /* una división inválida no cuenta */ }
        }
        const start = Math.min(lastEnd + 1, doc.pages);
        const div = { id: this.nextId++, text: start < doc.pages ? `${start}-${doc.pages}` : String(doc.pages) };
        doc.divisions.push(div);
        this.render();
        const row = this.listEl.querySelector(`.split-row[data-id="${div.id}"]`);
        if (row && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            gsap.fromTo(row, { autoAlpha: 0, y: -10 }, { autoAlpha: 1, y: 0, duration: 0.3, ease: 'power3.out', clearProps: 'all' });
        }
    }

    removeDivision(doc, div) {
        if (this.busy) return;
        doc.divisions = doc.divisions.filter(d => d !== div);
        this.render();
    }

    /** Renderiza (una sola vez) la miniatura de una hoja y devuelve su imagen como data URL. */
    thumb(doc, pageIndex) {
        if (!doc.thumbs.has(pageIndex)) {
            doc.thumbs.set(pageIndex, (async () => {
                const page = await doc.pdf.getPage(pageIndex + 1);
                const base = page.getViewport({ scale: 1 });
                const scale = Math.min(300 / base.width, 400 / base.height);
                const viewport = page.getViewport({ scale });
                const canvas = document.createElement('canvas');
                canvas.width = Math.floor(viewport.width);
                canvas.height = Math.floor(viewport.height);
                await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
                return canvas.toDataURL('image/png');
            })());
        }
        return doc.thumbs.get(pageIndex);
    }

    /** Todas las divisiones válidas, en orden: { doc, div, index, pages }. Devuelve null si alguna es inválida. */
    collectDivisions() {
        const result = [];
        for (const doc of this.docs) {
            if (doc.error || !doc.pdf) return null;
            for (const div of doc.divisions) {
                try {
                    result.push({ doc, div, pages: parseDivisionRange(div.text, doc.pages) });
                } catch (e) {
                    return null;
                }
            }
        }
        return result;
    }

    /** Cambia entre armar divisiones ('edit') y ordenar las partes para unirlas ('order'). */
    setMode(mode) {
        if (this.busy) return;
        if (mode === 'order') {
            const divisions = this.collectDivisions();
            if (!divisions || !divisions.length) return;
            this.order = divisions.map(d => d.div.id);
        }
        this.mode = mode;
        this.render();
        if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            gsap.fromTo(this.listEl, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.25, ease: 'power2.out', clearProps: 'all' });
        }
    }

    /** Divisiones en el orden elegido para unir. */
    orderedDivisions() {
        const divisions = this.collectDivisions() || [];
        const byId = new Map(divisions.map(d => [d.div.id, d]));
        return this.order.map(id => byId.get(id)).filter(Boolean);
    }

    /** Hojas (base 0) -> texto compacto: "1-5", "1-2, 4, 8". */
    rangeLabel(pages) {
        const parts = [];
        for (let i = 0; i < pages.length; i++) {
            let j = i;
            while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
            parts.push(i === j ? `${pages[i] + 1}` : `${pages[i] + 1}-${pages[j] + 1}`);
            i = j;
        }
        return parts.join(', ');
    }

    render() {
        this.closeGrid(true);
        this.listEl.innerHTML = '';
        if (this.mode === 'order') {
            this.renderOrder();
            return;
        }
        this.infoEl.textContent = 'Elegí las hojas de cada división con Página de inicio / fin o escribiendo un rango (ej.: 1-21, 3, 4, 8). Doble clic en una vista previa para ver todas las hojas de esa división.';
        let number = 0;
        for (const doc of this.docs) {
            const block = document.createElement('section');
            block.className = 'split-doc';
            const head = document.createElement('div');
            head.className = 'split-doc-head';
            head.innerHTML = `<span class="split-doc-icon">${icon('file-pdf')}</span>`;
            const name = document.createElement('span');
            name.className = 'split-doc-name';
            name.textContent = doc.name;
            name.title = doc.name;
            const meta = document.createElement('span');
            meta.className = 'split-doc-meta';
            meta.textContent = doc.error ? 'No se pudo leer' : doc.pages ? `${doc.pages} hoja(s)` : 'Cargando…';
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'btn-icon split-doc-remove';
            remove.title = 'Quitar este PDF';
            remove.innerHTML = icon('x');
            remove.disabled = this.busy;
            remove.addEventListener('click', () => this.removeDoc(doc));
            head.append(name, meta, remove);
            block.appendChild(head);

            if (doc.pdf) {
                doc.divisions.forEach(div => block.appendChild(this.buildRow(doc, div, ++number)));
                const add = document.createElement('button');
                add.type = 'button';
                add.className = 'split-add';
                add.title = 'Agregar una división (sigue desde la hoja siguiente a la anterior)';
                add.innerHTML = `${icon('plus')} Agregar división`;
                add.disabled = this.busy;
                add.addEventListener('click', () => this.addDivision(doc));
                block.appendChild(add);
            } else if (!doc.error) {
                block.insertAdjacentHTML('beforeend', '<div class="split-doc-loading"><span class="merge-spinner"></span></div>');
            }
            this.listEl.appendChild(block);
        }
        for (let i = 0; i < this.loading; i++) {
            this.listEl.insertAdjacentHTML('beforeend', '<div class="split-doc split-doc-loading"><span class="merge-spinner"></span></div>');
        }

        // Siempre queda un espacio para cargar otro PDF
        const slot = document.createElement('button');
        slot.type = 'button';
        slot.className = 'merge-empty split-empty';
        slot.disabled = this.busy;
        slot.innerHTML = `<span class="merge-empty-icon">${icon('file-arrow-up')}</span><span class="merge-empty-text">${this.docs.length ? 'Arrastrá otro PDF aquí o hacé clic para elegirlo' : 'Arrastrá un PDF aquí o hacé clic para elegirlo'}</span>`;
        slot.addEventListener('click', () => { if (!this.busy) this.fileInput.click(); });
        slot.addEventListener('dragover', () => slot.classList.add('over'));
        slot.addEventListener('dragleave', () => slot.classList.remove('over'));
        slot.addEventListener('drop', () => slot.classList.remove('over'));
        this.listEl.appendChild(slot);

        this.updateFooter();
    }

    /** Vista para unir: las partes como tarjetas que se ordenan arrastrándolas. */
    renderOrder(prevRects = null) {
        this.infoEl.textContent = 'Arrastrá las partes para elegir en qué orden se unen y tocá Aceptar.';
        this.listEl.innerHTML = '';
        const grid = document.createElement('div');
        grid.className = 'split-order-list';
        this.orderedDivisions().forEach((item, index) => grid.appendChild(this.buildOrderCard(item, index)));
        this.listEl.appendChild(grid);
        this.updateFooter();

        if (prevRects && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            grid.querySelectorAll('.merge-card[data-id]').forEach(el => {
                const prev = prevRects.get(el.dataset.id);
                if (!prev) return;
                const now = el.getBoundingClientRect();
                const dx = prev.left - now.left, dy = prev.top - now.top;
                if (dx || dy) gsap.fromTo(el, { x: dx, y: dy }, { x: 0, y: 0, duration: 0.35, ease: 'power3.out', clearProps: 'transform' });
            });
        }
    }

    buildOrderCard({ doc, div, pages }, index) {
        const card = document.createElement('div');
        card.className = 'merge-card';
        card.dataset.id = String(div.id);
        card.draggable = !this.busy;
        card.title = 'Arrastrá para cambiar el orden';
        card.innerHTML = `
            <span class="merge-order">${index + 1}</span>
            <div class="merge-thumb"><span class="merge-spinner"></span></div>
            <div class="merge-name"></div>
            <div class="merge-meta"></div>`;
        const name = card.querySelector('.merge-name');
        name.textContent = doc.name;
        name.title = doc.name;
        card.querySelector('.merge-meta').textContent = `Hojas ${this.rangeLabel(pages)} · ${pages.length} hoja(s)`;
        const thumb = card.querySelector('.merge-thumb');
        this.thumb(doc, pages[0]).then(url => {
            thumb.innerHTML = '';
            const img = document.createElement('img');
            img.src = url;
            img.draggable = false;
            thumb.appendChild(img);
        }).catch(err => console.error(err));

        const dropAfter = e => {
            const r = card.getBoundingClientRect();
            return e.clientX > r.left + r.width / 2;
        };
        card.addEventListener('dragstart', e => {
            this.dragId = div.id;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(div.id));
            card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => {
            this.dragId = null;
            card.classList.remove('dragging');
            this.listEl.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
        });
        card.addEventListener('dragover', e => {
            if (this.dragId === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            this.listEl.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
            card.classList.add(dropAfter(e) ? 'drop-after' : 'drop-before');
        });
        card.addEventListener('drop', e => {
            if (this.dragId === null) return;
            e.preventDefault();
            e.stopPropagation();
            const id = this.dragId;
            this.dragId = null;
            this.moveInOrder(id, index + (dropAfter(e) ? 1 : 0));
        });
        return card;
    }

    /** Mueve la parte `id` a la posición de inserción `index`. */
    moveInOrder(id, index) {
        const from = this.order.indexOf(id);
        if (from < 0) return;
        if (index > from) index -= 1;
        if (index === from) {
            this.renderOrder();
            return;
        }
        const rects = new Map();
        this.listEl.querySelectorAll('.merge-card[data-id]').forEach(el => rects.set(el.dataset.id, el.getBoundingClientRect()));
        this.order.splice(from, 1);
        this.order.splice(index, 0, id);
        this.renderOrder(rects);
    }

    updateFooter() {
        const divisions = this.collectDivisions();
        const ready = !!divisions && divisions.length > 0 && this.loading === 0;
        const ordering = this.mode === 'order';
        this.btnSeparate.hidden = ordering;
        this.btnZip.hidden = ordering;
        this.btnBack.hidden = !ordering;
        this.btnSeparate.disabled = !ready || this.busy;
        this.btnZip.disabled = !ready || this.busy;
        this.btnBack.disabled = this.busy;
        this.btnJoin.disabled = !ready || this.busy;
        this.btnJoin.classList.toggle('default', ordering);
        this.btnJoin.innerHTML = ordering ? `${icon('check')} Aceptar` : `${icon('arrows-merge')} Unir`;
        this.btnJoin.title = ordering ? 'Unir las partes en este orden y abrir el resultado' : 'Ordenar las partes y unirlas en un solo PDF';
        if (this.busy) return;
        if (ordering) {
            const total = divisions ? divisions.reduce((s, d) => s + d.pages.length, 0) : 0;
            this.setStatus(`${this.order.length} parte(s) · ${total} hoja(s) en total`);
            return;
        }
        if (!this.docs.length) this.setStatus('Cargá un PDF para dividirlo.');
        else if (this.docs.some(d => d.error)) this.setStatus('Hay archivos que no se pudieron leer: quitalos para continuar.');
        else if (!divisions) this.setStatus('Hay divisiones con un rango inválido.');
        else if (ready) {
            const total = divisions.reduce((s, d) => s + d.pages.length, 0);
            this.setStatus(`${divisions.length} división(es) · ${total} hoja(s) en total`);
        } else this.setStatus('');
    }

    buildRow(doc, div, number) {
        const row = document.createElement('div');
        row.className = 'split-row';
        row.dataset.id = String(div.id);
        row.innerHTML = `
            <span class="merge-order split-order" title="División ${number}">${number}</span>
            <div class="split-preview" data-pos="first" title="Doble clic: ver todas las hojas de la división">
                <div class="split-thumb"></div><div class="split-cap">Inicio</div>
            </div>
            <div class="split-preview" data-pos="last" title="Doble clic: ver todas las hojas de la división">
                <div class="split-thumb"></div><div class="split-cap">Fin</div>
            </div>
            <div class="split-fields">
                <label>Página de inicio <input type="number" class="spin split-from" min="1" max="${doc.pages}"></label>
                <label>Página de fin <input type="number" class="spin split-to" min="1" max="${doc.pages}"></label>
                <label class="split-range-label">Rango (ej.: 1-21, 3, 4, 8) <input type="text" class="input-field split-range" spellcheck="false" autocomplete="off"></label>
                <span class="split-count"></span>
            </div>
        `;
        const from = row.querySelector('.split-from');
        const to = row.querySelector('.split-to');
        const range = row.querySelector('.split-range');
        range.value = div.text;

        if (doc.divisions.length > 1) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'merge-remove split-remove';
            remove.title = 'Quitar esta división';
            remove.innerHTML = icon('x');
            remove.addEventListener('click', () => this.removeDivision(doc, div));
            row.appendChild(remove);
        }

        const sync = ({ fromFields }) => {
            let pages = null;
            try { pages = parseDivisionRange(div.text, doc.pages); } catch (e) { /* inválido */ }
            if (!fromFields) {
                from.value = pages ? String(pages[0] + 1) : '';
                to.value = pages ? String(pages[pages.length - 1] + 1) : '';
            }
            row.classList.toggle('invalid', !pages);
            row.querySelector('.split-count').textContent = pages ? `${pages.length} hoja(s)` : 'Rango inválido';
            this.updatePreviews(row, doc, pages);
            this.updateFooter();
        };

        const onFields = () => {
            const a = parseInt(from.value, 10), b = parseInt(to.value, 10);
            if (Number.isNaN(a) || Number.isNaN(b) || a < 1 || b > doc.pages || a > b) {
                div.text = '';
                range.value = '';
                sync({ fromFields: true });
                return;
            }
            div.text = a === b ? String(a) : `${a}-${b}`;
            range.value = div.text;
            sync({ fromFields: true });
        };
        from.addEventListener('input', onFields);
        to.addEventListener('input', onFields);
        range.addEventListener('input', () => { div.text = range.value; sync({ fromFields: false }); });

        row.querySelectorAll('.split-preview').forEach(p => {
            p.addEventListener('dblclick', () => {
                try { this.openGrid(doc, number, parseDivisionRange(div.text, doc.pages)); } catch (e) { /* inválido */ }
            });
        });

        sync({ fromFields: false });
        return row;
    }

    updatePreviews(row, doc, pages) {
        [['first', pages ? pages[0] : null], ['last', pages ? pages[pages.length - 1] : null]].forEach(([pos, pageIndex]) => {
            const box = row.querySelector(`.split-preview[data-pos="${pos}"]`);
            const thumb = box.querySelector('.split-thumb');
            box.querySelector('.split-cap').textContent = `${pos === 'first' ? 'Inicio' : 'Fin'}${pageIndex !== null ? ` · hoja ${pageIndex + 1}` : ''}`;
            if (pageIndex === null) { thumb.innerHTML = ''; return; }
            if (thumb.dataset.page === String(pageIndex) && thumb.querySelector('img')) return;
            thumb.dataset.page = String(pageIndex);
            thumb.innerHTML = '<span class="merge-spinner"></span>';
            this.thumb(doc, pageIndex).then(url => {
                if (thumb.dataset.page !== String(pageIndex)) return;
                thumb.innerHTML = '';
                const img = document.createElement('img');
                img.src = url;
                img.alt = `Hoja ${pageIndex + 1}`;
                img.draggable = false;
                thumb.appendChild(img);
            }).catch(err => {
                console.error(err);
                if (thumb.dataset.page === String(pageIndex)) thumb.innerHTML = `<span class="merge-error">${icon('warning')}</span>`;
            });
        });
    }

    /** Cuadrícula de sólo lectura con todas las hojas de una división (doble clic en la vista previa). */
    openGrid(doc, number, pages) {
        this.closeGrid(true);
        const overlay = document.createElement('div');
        overlay.className = 'split-grid';
        overlay.innerHTML = `
            <div class="split-grid-head">
                <span><b>División ${number}</b> · ${pages.length} hoja(s) de ${doc.pages} · ${this.escape(doc.name)}</span>
                <button type="button" class="btn-icon" title="Volver (Esc)">${icon('x')}</button>
            </div>
            <div class="split-grid-list"></div>`;
        overlay.querySelector('.split-grid-head button').addEventListener('click', () => this.closeGrid());
        overlay.addEventListener('dblclick', e => { if (e.target === overlay) this.closeGrid(); });
        const list = overlay.querySelector('.split-grid-list');
        const cells = pages.map(pageIndex => {
            const cell = document.createElement('div');
            cell.className = 'split-grid-cell';
            cell.innerHTML = `<div class="split-grid-thumb"><span class="merge-spinner"></span></div><div class="split-grid-label">${pageIndex + 1}</div>`;
            list.appendChild(cell);
            return cell;
        });
        this.dlg.appendChild(overlay);
        this.gridEl = overlay;
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        gsap.fromTo(overlay, { autoAlpha: 0 }, { autoAlpha: 1, duration: reduce ? 0 : 0.2, ease: 'power2.out' });
        if (!reduce) gsap.fromTo(cells.slice(0, 24), { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.3, stagger: 0.02, ease: 'power2.out', clearProps: 'all' });

        // Se dibujan de a una para no trabar la ventana con documentos grandes
        const token = ++this.gridToken;
        (async () => {
            for (let i = 0; i < pages.length; i++) {
                if (token !== this.gridToken) return;
                try {
                    const url = await this.thumb(doc, pages[i]);
                    if (token !== this.gridToken) return;
                    const box = cells[i].querySelector('.split-grid-thumb');
                    box.innerHTML = '';
                    const img = document.createElement('img');
                    img.src = url;
                    img.draggable = false;
                    box.appendChild(img);
                } catch (e) { console.error(e); }
            }
        })();
    }

    closeGrid(immediate = false) {
        if (!this.gridEl) return;
        this.gridToken++;
        const el = this.gridEl;
        this.gridEl = null;
        if (immediate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) el.remove();
        else gsap.to(el, { autoAlpha: 0, duration: 0.15, ease: 'power2.in', onComplete: () => el.remove() });
    }

    escape(text) {
        const span = document.createElement('span');
        span.textContent = text;
        return span.innerHTML;
    }

    setStatus(text) {
        this.statusEl.textContent = text;
    }

    setBusy(busy, text = '') {
        this.busy = busy;
        this.dlg.classList.toggle('is-busy', busy);
        this.dlg.querySelectorAll('.split-list button, .split-list input').forEach(el => { el.disabled = busy; });
        this.updateFooter();
        if (busy) this.setStatus(text);
    }

    /** Arma un PDF por división: [{ name, bytes }]. */
    async buildDivisionFiles(divisions) {
        const loaded = new Map();
        const used = new Set();
        const files = [];
        for (const { doc, pages } of divisions) {
            if (!loaded.has(doc)) loaded.set(doc, await loadLibDoc(doc.bytes));
            const out = await extractPagesToNewDoc(loaded.get(doc), pages);
            const first = pages[0] + 1, last = pages[pages.length - 1] + 1;
            const base = `${baseNameWithoutExt(doc.name)}_${first === last ? `p${first}` : `p${first}-${last}`}`;
            let name = `${base}.pdf`;
            for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}.pdf`;
            used.add(name.toLowerCase());
            files.push({ name, bytes: await out.save() });
        }
        return files;
    }

    /** Todas las divisiones unidas en un solo PDF. */
    async buildJoinedBytes(divisions) {
        const out = await PDFDocument.create();
        const loaded = new Map();
        for (const { doc, pages } of divisions) {
            if (!loaded.has(doc)) loaded.set(doc, await loadLibDoc(doc.bytes));
            const copied = await out.copyPages(loaded.get(doc), pages);
            copied.forEach(p => out.addPage(p));
        }
        return out.save();
    }

    /** Ejecuta una descarga mostrando el estado; la ventana queda abierta. */
    async runDownload(job) {
        const divisions = this.collectDivisions();
        if (this.busy || !divisions || !divisions.length) return;
        this.setBusy(true, 'Preparando archivos…');
        let saved = null;
        try {
            saved = await job(divisions);
        } catch (e) {
            console.error(e);
            this.setBusy(false);
            await msgCritical('Error', `No se pudo dividir el documento:\n${e.message || e}`);
            return;
        }
        this.setBusy(false);
        if (saved) this.setStatus(`${saved} Podés seguir editando o cerrar la ventana.`);
    }

    /** Un PDF por división, cada uno como descarga aparte (con una sola, se elige dónde guardarla). */
    downloadSeparate() {
        return this.runDownload(async divisions => {
            if (divisions.length === 1) {
                const saved = await saveBytesAs(this.singleName(divisions[0]),
                    async () => (await this.buildDivisionFiles(divisions))[0].bytes);
                return saved ? `Se descargó "${saved}".` : null;
            }
            const files = await this.buildDivisionFiles(divisions);
            for (let i = 0; i < files.length; i++) {
                downloadBlob(new Blob([files[i].bytes], { type: 'application/pdf' }), files[i].name);
                // una pausa corta entre descargas para que el navegador no descarte ninguna
                if (i < files.length - 1) await new Promise(r => setTimeout(r, 350));
            }
            return `Se descargaron ${files.length} archivos PDF.`;
        });
    }

    /** Todas las divisiones en un ZIP (un PDF por división). */
    downloadZip() {
        return this.runDownload(async divisions => {
            const files = await this.buildDivisionFiles(divisions);
            const zip = new JSZip();
            files.forEach(f => zip.file(f.name, f.bytes));
            const blob = await zip.generateAsync({ type: 'blob' });
            const name = `${baseNameWithoutExt(divisions[0].doc.name)}_dividido.zip`;
            downloadBlob(blob, name);
            return `Se descargó "${name}".`;
        });
    }

    singleName({ doc, pages }) {
        const first = pages[0] + 1, last = pages[pages.length - 1] + 1;
        return `${baseNameWithoutExt(doc.name)}_${first === last ? `p${first}` : `p${first}-${last}`}.pdf`;
    }

    /** Aceptar (vista Unir): une las partes en el orden elegido y abre el resultado en el lector. */
    async acceptJoin() {
        const divisions = this.orderedDivisions();
        if (this.busy || !divisions.length) return;
        this.setBusy(true, 'Uniendo partes…');
        try {
            const bytes = await this.buildJoinedBytes(divisions);
            const name = divisions.length === 1 ? this.singleName(divisions[0]) : `${baseNameWithoutExt(divisions[0].doc.name)}_unido.pdf`;
            this.finish({ bytes, name });
        } catch (e) {
            console.error(e);
            this.setBusy(false);
            await msgCritical('Error', `No se pudieron unir las partes:\n${e.message || e}`);
        }
    }

    finish(result) {
        this.closeGrid(true);
        closeDialog(this.dlg);
        this.docs.forEach(d => { if (d.pdf) d.pdf.destroy(); });
        this.resolve(result);
    }
}
