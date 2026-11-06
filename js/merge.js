/* =========================================================================
 * merge.js
 * Ventana "Unir PDF": se cargan dos o más PDF (arrastrándolos o con clic en
 * los espacios vacíos), se ve la primera hoja de cada uno y se ordenan
 * arrastrándolos. Desde ahí se descarga el PDF unido (la ventana sigue
 * abierta) o se une y se abre en el lector. Sólo se cierra con la X / Esc.
 * Devuelve { bytes, includesCurrent } al elegir "Unir y abrir", o null.
 * ========================================================================= */

class MergeDialog {
    /** `current` = { name, bytes } del documento abierto (opcional): entra como primer archivo. */
    constructor(current = null) {
        this.items = [];   // { id, name, bytes, pages, thumb (canvas|null), isCurrent }
        this.nextId = 1;
        this.dragId = null;
        this.busy = false;
        this.loading = 0;  // archivos que se están leyendo
        if (current) {
            this.items.push({ id: this.nextId++, name: current.name, bytes: current.bytes, pages: 0, thumb: null, isCurrent: true });
        }
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

    open() {
        return new Promise(resolve => {
            this.resolve = resolve;
            this.build();
            this.render();
            this.dlg.showModal();
            // El documento abierto se procesa al abrir la ventana (miniatura y cantidad de hojas)
            this.items.forEach(item => this.prepareItem(item));
        });
    }

    build() {
        const dlg = document.createElement('dialog');
        dlg.className = 'qt-dialog merge-dialog';
        dlg.innerHTML = `
            <div class="dialog-title merge-title">
                <span>Unir PDF</span>
                <button type="button" class="btn-icon merge-close" title="Cerrar (Esc)">${icon('x')}</button>
            </div>
            <div class="merge-info">Cargá dos o más PDF (arrastrándolos o haciendo clic en un espacio vacío) y arrastrá las tarjetas para elegir el orden.</div>
            <div class="merge-list"></div>
            <div class="dialog-buttons merge-buttons">
                <span class="merge-status" aria-live="polite"></span>
                <button type="button" data-act="download">${icon('download-simple')} Descargar PDF</button>
                <button type="button" data-act="open" class="default">${icon('arrows-merge')} Unir y abrir</button>
            </div>
        `;
        dlg.appendChild(this.fileInput);
        document.body.appendChild(dlg);
        this.dlg = dlg;
        this.listEl = dlg.querySelector('.merge-list');
        this.statusEl = dlg.querySelector('.merge-status');
        this.btnDownload = dlg.querySelector('[data-act="download"]');
        this.btnOpen = dlg.querySelector('[data-act="open"]');

        dlg.querySelector('.merge-close').addEventListener('click', () => this.finish(null));
        this.btnDownload.addEventListener('click', () => this.download());
        this.btnOpen.addEventListener('click', () => this.mergeAndOpen());

        dlg.addEventListener('cancel', e => {
            e.preventDefault();
            if (!this.busy) this.finish(null);
        });

        // Archivos soltados en cualquier parte de la ventana se agregan al final
        dlg.addEventListener('dragover', e => {
            if (!this.isFileDrag(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            dlg.classList.add('file-over');
        });
        dlg.addEventListener('dragleave', e => {
            if (!dlg.contains(e.relatedTarget)) dlg.classList.remove('file-over');
        });
        dlg.addEventListener('drop', e => {
            dlg.classList.remove('file-over');
            if (!this.isFileDrag(e)) return;
            e.preventDefault();
            this.addFiles(Array.from(e.dataTransfer.files));
        });
    }

    isFileDrag(e) {
        return this.dragId === null && e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    }

    /** Lee la cantidad de hojas y dibuja la primera hoja de un archivo. */
    async prepareItem(item) {
        try {
            const pdf = await pdfjsLib.getDocument({
                data: item.bytes.slice(),
                cMapUrl: `${PDFJS_ASSETS}cmaps/`,
                cMapPacked: true,
                standardFontDataUrl: `${PDFJS_ASSETS}standard_fonts/`,
                worker: pdfjsWorker()
            }).promise;
            item.pages = pdf.numPages;
            const page = await pdf.getPage(1);
            const base = page.getViewport({ scale: 1 });
            const scale = Math.min(320 / base.width, 420 / base.height);
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            item.thumb = canvas;
            pdf.destroy();
        } catch (e) {
            console.error(e);
            item.error = true;
        }
        if (!this.items.includes(item)) return;
        // Redibujar en medio de un arrastre cortaría el arrastre: se hace al soltar
        if (this.dragId !== null) this.pendingRender = true;
        else this.render();
    }

    async addFiles(files) {
        if (this.busy) return;
        const pdfs = files.filter(f => isPdfName(f.name));
        const skipped = files.length - pdfs.length;
        this.loading += pdfs.length;
        this.render();
        for (const file of pdfs) {
            const item = { id: this.nextId++, name: file.name, bytes: await readFileBytes(file), pages: 0, thumb: null, isCurrent: false };
            this.loading -= 1;
            this.items.push(item);
            this.render();
            this.prepareItem(item);
        }
        if (skipped) this.setStatus(`Se ignoraron ${skipped} archivo(s) que no son PDF.`);
    }

    removeItem(id) {
        if (this.busy) return;
        this.items = this.items.filter(it => it.id !== id);
        this.render();
    }

    /** Mueve la tarjeta `id` a la posición `index` (índice de inserción en la lista actual). */
    moveItem(id, index) {
        const from = this.items.findIndex(it => it.id === id);
        if (from < 0) return;
        if (index > from) index -= 1;
        if (index === from) return;
        const rects = this.cardRects();
        const [item] = this.items.splice(from, 1);
        this.items.splice(index, 0, item);
        this.render(rects);
    }

    cardRects() {
        const rects = new Map();
        this.listEl.querySelectorAll('.merge-card[data-id]').forEach(el => rects.set(el.dataset.id, el.getBoundingClientRect()));
        return rects;
    }

    /** Vuelve a dibujar las tarjetas; con `prevRects` anima el cambio de orden (técnica FLIP con GSAP). */
    render(prevRects = null) {
        this.pendingRender = false;
        this.listEl.innerHTML = '';
        this.items.forEach((item, index) => this.listEl.appendChild(this.buildCard(item, index)));
        for (let i = 0; i < this.loading; i++) {
            const ph = document.createElement('div');
            ph.className = 'merge-card merge-loading';
            ph.innerHTML = '<div class="merge-thumb"><span class="merge-spinner"></span></div><div class="merge-name">Cargando…</div>';
            this.listEl.appendChild(ph);
        }
        // Siempre hay al menos dos espacios en total y uno libre para seguir agregando
        const empties = Math.max(1, 2 - this.items.length - this.loading);
        for (let i = 0; i < empties; i++) this.listEl.appendChild(this.buildEmptySlot());

        const ready = this.items.length >= 2 && this.loading === 0 && this.items.every(it => !it.error);
        this.btnDownload.disabled = !ready || this.busy;
        this.btnOpen.disabled = !ready || this.busy;
        if (!this.busy) {
            const total = this.items.reduce((s, it) => s + (it.pages || 0), 0);
            if (this.items.some(it => it.error)) this.setStatus('Hay archivos que no se pudieron leer: quitalos para continuar.');
            else if (this.items.length >= 2) this.setStatus(`${this.items.length} archivos · ${total} hoja(s) en total`);
            else this.setStatus('Cargá al menos dos PDF para unirlos.');
        }

        if (prevRects && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            this.listEl.querySelectorAll('.merge-card[data-id]').forEach(el => {
                const prev = prevRects.get(el.dataset.id);
                if (!prev) return;
                const now = el.getBoundingClientRect();
                const dx = prev.left - now.left, dy = prev.top - now.top;
                if (dx || dy) gsap.fromTo(el, { x: dx, y: dy }, { x: 0, y: 0, duration: 0.35, ease: 'power3.out', clearProps: 'transform' });
            });
        }
    }

    buildCard(item, index) {
        const card = document.createElement('div');
        card.className = 'merge-card';
        card.dataset.id = String(item.id);
        card.draggable = !this.busy;
        card.title = 'Arrastrá para cambiar el orden';

        const order = document.createElement('span');
        order.className = 'merge-order';
        order.textContent = String(index + 1);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'merge-remove';
        remove.title = 'Quitar de la lista';
        remove.innerHTML = icon('x');
        remove.addEventListener('click', e => { e.stopPropagation(); this.removeItem(item.id); });

        const thumb = document.createElement('div');
        thumb.className = 'merge-thumb';
        if (item.thumb) thumb.appendChild(item.thumb);
        else if (item.error) thumb.innerHTML = `<span class="merge-error">${icon('warning')}<br>No se pudo leer</span>`;
        else thumb.innerHTML = '<span class="merge-spinner"></span>';

        const name = document.createElement('div');
        name.className = 'merge-name';
        name.textContent = item.name;
        name.title = item.name;

        const meta = document.createElement('div');
        meta.className = 'merge-meta';
        meta.textContent = (item.isCurrent ? 'Abierto · ' : '') + (item.pages ? `${item.pages} hoja(s)` : '');

        card.append(order, remove, thumb, name, meta);

        card.addEventListener('dragstart', e => {
            this.dragId = item.id;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(item.id));
            card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => {
            this.dragId = null;
            card.classList.remove('dragging');
            this.clearDropMarker();
            if (this.pendingRender) this.render();
        });
        card.addEventListener('dragover', e => {
            if (this.dragId === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const r = card.getBoundingClientRect();
            const after = e.clientX > r.left + r.width / 2;
            this.showDropMarker(card, after);
        });
        card.addEventListener('drop', e => {
            if (this.dragId === null) return;
            e.preventDefault();
            e.stopPropagation();
            const r = card.getBoundingClientRect();
            const after = e.clientX > r.left + r.width / 2;
            const id = this.dragId;
            this.dragId = null;
            this.clearDropMarker();
            this.moveItem(id, index + (after ? 1 : 0));
        });
        return card;
    }

    buildEmptySlot() {
        const slot = document.createElement('button');
        slot.type = 'button';
        slot.className = 'merge-card merge-empty';
        slot.disabled = this.busy;
        slot.innerHTML = `<span class="merge-empty-icon">${icon('file-arrow-up')}</span><span class="merge-empty-text">Arrastrá un PDF aquí<br>o hacé clic para elegirlo</span>`;
        slot.addEventListener('click', () => { if (!this.busy) this.fileInput.click(); });
        slot.addEventListener('dragover', e => {
            if (this.dragId !== null) { // una tarjeta soltada en un espacio vacío va al final
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                this.clearDropMarker();
            }
            slot.classList.add('over');
        });
        slot.addEventListener('dragleave', () => slot.classList.remove('over'));
        slot.addEventListener('drop', e => {
            slot.classList.remove('over');
            if (this.dragId === null) return; // archivos: los toma la ventana
            e.preventDefault();
            e.stopPropagation();
            const id = this.dragId;
            this.dragId = null;
            this.moveItem(id, this.items.length);
        });
        return slot;
    }

    showDropMarker(card, after) {
        this.clearDropMarker();
        card.classList.add(after ? 'drop-after' : 'drop-before');
    }

    clearDropMarker() {
        this.listEl.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
    }

    setStatus(text) {
        this.statusEl.textContent = text;
    }

    setBusy(busy, text = '') {
        this.busy = busy;
        this.dlg.classList.toggle('is-busy', busy);
        this.render();
        if (busy) this.setStatus(text);
    }

    async buildMergedBytes() {
        const out = await PDFDocument.create();
        for (const item of this.items) {
            await insertPdfBytes(out, item.bytes, out.getPageCount());
        }
        return out.save();
    }

    defaultName() {
        const first = this.items[0] ? baseNameWithoutExt(this.items[0].name) : 'documento';
        return `${first}_unido.pdf`;
    }

    /** Descarga el PDF unido; la ventana queda abierta para seguir ordenando o agregando. */
    async download() {
        if (this.busy || this.btnDownload.disabled) return;
        this.setBusy(true, 'Uniendo archivos…');
        let saved = null;
        try {
            saved = await saveBytesAs(this.defaultName(), () => this.buildMergedBytes());
        } catch (e) {
            console.error(e);
            this.setBusy(false);
            await msgCritical('Error', `No se pudieron unir los archivos:\n${e.message || e}`);
            return;
        }
        this.setBusy(false);
        if (saved) this.setStatus(`Se descargó "${saved}". Podés seguir editando o cerrar la ventana.`);
    }

    async mergeAndOpen() {
        if (this.busy || this.btnOpen.disabled) return;
        this.setBusy(true, 'Uniendo archivos…');
        try {
            const bytes = await this.buildMergedBytes();
            this.finish({ bytes, name: this.defaultName(), includesCurrent: this.items.some(it => it.isCurrent) });
        } catch (e) {
            console.error(e);
            this.setBusy(false);
            await msgCritical('Error', `No se pudieron unir los archivos:\n${e.message || e}`);
        }
    }

    finish(result) {
        closeDialog(this.dlg);
        this.items.forEach(it => { it.thumb = null; });
        this.resolve(result);
    }
}
