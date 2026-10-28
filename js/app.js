/* =========================================================================
 * app.js
 * Ventana principal (equivalente a PDFViewerWindow + InteractivePDFLabel +
 * DraggableThumbnailList de B51.py).
 * ========================================================================= */

const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
const PDFJS_ASSETS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/';
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
const PAKO_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js';
const UTIF_URL = 'https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}pdf.worker.min.js`;

const BASE_TITLE = 'Editor y Convertidor de PDF Professional';
const VALID_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.webp', '.tiff', '.tif'];
const DRAG_MODES = ['highlight', 'rect', 'underline', 'strike', 'arrow', 'line', 'crop', 'erase_area', 'copy_text', 'select', 'qr'];

/* ---------- Estado (atributos de PDFViewerWindow) ---------- */

const state = {
    pdfBytes: null,          // documento actual (fuente de verdad, como self.pdf_document)
    pdfJsDoc: null,          // documento cargado en pdf.js para renderizar / extraer texto
    currentFilePath: null,   // nombre del archivo actual
    fileHandle: null,        // FileSystemFileHandle del archivo actual (permite sobrescribir con Guardar)
    currentPage: 0,
    totalPages: 0,
    zoomFactor: 1.5,
    currentMode: 'navigate',
    brushColor: [0.0, 0.0, 0.0],
    brushWidth: 2,
    fontSize: 14,
    signatures: [],          // firmas cargadas: { name, image, width, height, url }
    isModified: false,
    darkMode: false,
    undoStack: [],
    redoStack: [],
    maxHistory: 20,
    pageMapper: null         // conversor pantalla <-> PDF de la página visible
};

const $ = id => document.getElementById(id);

const ui = {
    btnOpen: $('btn-open'),
    btnSave: $('btn-save'),
    btnSaveAs: $('btn-save-as'),
    btnPrint: $('btn-print'),
    btnExport: $('btn-export'),
    btnExportImg: $('btn-export-img'),
    btnExportPdf: $('btn-export-pdf'),
    btnUndo: $('btn-undo'),
    btnRedo: $('btn-redo'),
    searchInput: $('search-input'),
    searchCount: $('search-count'),
    searchPrev: $('search-prev'),
    searchNext: $('search-next'),
    searchClear: $('search-clear'),
    btnGridView: $('btn-grid-view'),
    btnQrValidate: $('btn-qr-validate'),
    btnMerge: $('btn-merge'),
    btnSplit: $('btn-split'),
    btnSignature: $('btn-signature'),
    signatureList: $('signature-list'),
    btnInsertImg: $('btn-insert-img'),
    btnRotateLeft: $('btn-rotate-left'),
    btnRotateRight: $('btn-rotate-right'),
    btnDeletePage: $('btn-delete-page'),
    btnBlankPage: $('btn-blank-page'),
    btnPrev: $('btn-prev'),
    lblPageInfo: $('lbl-page-info'),
    spinPage: $('spin-page'),
    btnNext: $('btn-next'),
    btnZoomOut: $('btn-zoom-out'),
    btnZoomIn: $('btn-zoom-in'),
    btnTheme: $('btn-theme'),
    btnColor: $('btn-color'),
    colorInput: $('color-input'),
    spinWidth: $('spin-width'),
    thumbList: $('thumbnail-list'),
    scrollArea: $('scroll-area'),
    placeholder: $('page-placeholder'),
    pageWrapper: $('page-wrapper'),
    pageCanvas: $('page-canvas'),
    overlay: $('overlay-canvas'),
    statusBar: $('status-bar'),
    textFormatBar: $('text-format-bar'),
    fileOpen: $('file-open'),
    fileMerge: $('file-merge'),
    fileImages: $('file-images'),
    printArea: $('print-area')
};

/* ---------- Cola de tareas (evita ediciones simultáneas) ---------- */

let taskChain = Promise.resolve();

function runTask(fn) {
    commitTextEditor(); // un texto en edición se aplica antes de cualquier otra operación
    commitImageEditor(); // igual que una imagen pegada pendiente de ubicar
    const task = taskChain.then(async () => {
        document.body.classList.add('busy');
        try {
            await fn();
        } finally {
            document.body.classList.remove('busy');
        }
    }).catch(err => {
        console.error(err);
        return msgCritical('Error', `Ocurrió un error inesperado:\n${err && err.message ? err.message : err}`);
    });
    taskChain = task;
    return task;
}

/* ---------- Barra de estado / título ---------- */

let statusTimer = null;

function showStatus(message, timeout = 0, iconName = '') {
    clearTimeout(statusTimer);
    ui.statusBar.innerHTML = iconName ? icon(iconName) + ' ' : '';
    ui.statusBar.append(message);
    if (timeout > 0) {
        statusTimer = setTimeout(() => { ui.statusBar.textContent = ''; }, timeout);
    }
}

function updateWindowTitle() {
    const fileInfo = state.currentFilePath ? ` - ${state.currentFilePath}` : '';
    const modFlag = state.isModified ? ' *' : '';
    document.title = `${BASE_TITLE}${fileInfo}${modFlag}`;
}

function setModified(modified = true) {
    state.isModified = modified;
    ui.btnSave.disabled = !modified;

    let title = 'Editor PDF';
    if (state.currentFilePath) title += ` - ${state.currentFilePath}`;
    if (state.isModified) title += ' *';
    document.title = title;
}

function enableControls(enable) {
    [ui.btnGridView, ui.btnQrValidate, ui.btnMerge, ui.btnSplit, ui.btnSignature,ui.btnPrint, ui.btnExport, ui.btnExportImg, ui.btnExportPdf,
     ui.btnInsertImg, ui.btnPrev, ui.btnNext, ui.btnZoomIn, ui.btnZoomOut, ui.btnDeletePage, ui.btnBlankPage,
     ui.btnRotateLeft, ui.btnRotateRight, ui.btnSave, ui.btnSaveAs, ui.spinPage, ui.searchInput].forEach(el => { el.disabled = !enable; });
}

function hasDocument() {
    return state.pdfBytes !== null;
}

/* ---------- Tema ---------- */

function toggleTheme() {
    state.darkMode = !state.darkMode;
    document.body.classList.toggle('dark', state.darkMode);
    ui.btnTheme.innerHTML = state.darkMode ? `${icon('sun')} Modo Claro` : `${icon('moon')} Modo Oscuro`;
}

/* ---------- Utilidades de archivos ---------- */

const loadedScripts = new Map();

function loadScript(url) {
    if (!loadedScripts.has(url)) {
        loadedScripts.set(url, new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url;
            s.onload = resolve;
            s.onerror = () => reject(new Error(`No se pudo cargar ${url}`));
            document.head.appendChild(s);
        }));
    }
    return loadedScripts.get(url);
}

function extensionOf(name) {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function isPdfName(name) {
    return extensionOf(name) === '.pdf';
}

function baseNameWithoutExt(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) : name;
}

async function readFileBytes(file) {
    return new Uint8Array(await file.arrayBuffer());
}

function canvasToBlob(canvas, type = 'image/png', quality = 0.92) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('No se pudo generar la imagen.'))), type, quality);
    });
}

async function canvasToPngBytes(canvas) {
    return new Uint8Array(await (await canvasToBlob(canvas, 'image/png')).arrayBuffer());
}

function detectImageType(bytes) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
    return null;
}

/** Decodifica cualquier imagen soportada por el navegador y la convierte a PNG. */
async function decodeWithBrowser(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    return { bytes: await canvasToPngBytes(canvas), type: 'png', width: canvas.width, height: canvas.height };
}

/** TIFF (posiblemente multipágina) -> lista de imágenes PNG. */
async function decodeTiff(bytes) {
    await loadScript(PAKO_URL);
    await loadScript(UTIF_URL);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const ifds = UTIF.decode(buffer).filter(ifd => ifd.t256 && ifd.t257);
    const images = [];
    for (const ifd of ifds) {
        UTIF.decodeImage(buffer, ifd);
        const rgba = UTIF.toRGBA8(ifd);
        const canvas = document.createElement('canvas');
        canvas.width = ifd.width;
        canvas.height = ifd.height;
        const imageData = canvas.getContext('2d').createImageData(ifd.width, ifd.height);
        imageData.data.set(rgba);
        canvas.getContext('2d').putImageData(imageData, 0, 0);
        images.push({ bytes: await canvasToPngBytes(canvas), type: 'png', width: canvas.width, height: canvas.height });
    }
    return images;
}

/** Convierte un archivo de imagen a una o varias imágenes insertables (PNG/JPG). */
async function fileToImages(file) {
    const bytes = await readFileBytes(file);
    const type = detectImageType(bytes);
    if (type) return [{ bytes, type }];
    const ext = extensionOf(file.name);
    if (ext === '.tif' || ext === '.tiff') {
        try {
            return [await decodeWithBrowser(file)];
        } catch (e) {
            return decodeTiff(bytes);
        }
    }
    return [await decodeWithBrowser(file)];
}

/** Inserta una imagen como página A4; si pdf-lib no puede embeberla, se re-codifica con el navegador. */
async function insertImageSafely(doc, img, index) {
    try {
        await insertImageAsA4Page(doc, img, index);
    } catch (e) {
        const reencoded = await decodeWithBrowser(new Blob([img.bytes]));
        await insertImageAsA4Page(doc, reencoded, index);
    }
}

/** Inserta un archivo (PDF o imagen) en `index`. Devuelve la cantidad de páginas insertadas. */
async function insertFileIntoDoc(doc, file, index) {
    if (isPdfName(file.name)) {
        return insertPdfBytes(doc, await readFileBytes(file), index);
    }
    const images = await fileToImages(file);
    for (let i = 0; i < images.length; i++) {
        await insertImageSafely(doc, images[i], index + i);
    }
    return images.length;
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Equivalente a QFileDialog.getSaveFileName para PDF. Si el navegador soporta el
 * selector de archivos lo usa; si no, descarga el archivo.
 * `getBytes` se invoca después de elegir destino. Devuelve el nombre elegido o null si se cancela.
 * El selector usa un `id` fijo: el navegador recuerda la última carpeta usada (al abrir o guardar).
 * `onHandle` recibe el handle del archivo elegido (si el navegador lo soporta).
 */
const FILE_PICKER_ID = 'lector-pdf';

async function saveBytesAs(suggestedName, getBytes, onHandle) {
    if (window.showSaveFilePicker) {
        let handle;
        try {
            handle = await window.showSaveFilePicker({
                id: FILE_PICKER_ID,
                suggestedName,
                types: [{ description: 'Archivos PDF', accept: { 'application/pdf': ['.pdf'] } }]
            });
        } catch (e) {
            if (e.name === 'AbortError') return null;
            handle = null;
        }
        if (handle) {
            const bytes = await getBytes();
            const writable = await handle.createWritable();
            await writable.write(bytes);
            await writable.close();
            if (onHandle) onHandle(handle);
            return handle.name;
        }
    }
    const bytes = await getBytes();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), suggestedName);
    return suggestedName;
}

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return;
    } catch (e) { /* se usa el método alternativo */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
}

/* ---------- Carga / fusión de archivos (load_or_merge_dropped_files) ---------- */

function filterValidFiles(fileList) {
    return Array.from(fileList).filter(f => VALID_EXTENSIONS.includes(extensionOf(f.name)));
}

/** Crea un documento nuevo desde cero con los archivos dados, descartando el actual y su historial. */
async function loadNewDocument(files, fileHandle = null) {
    const nuevoPdf = await PDFDocument.create();
    for (const file of files) {
        await insertFileIntoDoc(nuevoPdf, file, nuevoPdf.getPageCount());
    }
    if (nuevoPdf.getPageCount() === 0) throw new Error('El documento no contiene páginas.');
    const bytes = await nuevoPdf.save();

    closeTextEditor();
    closeImageEditor();
    hidePasteHint();
    state.undoStack = [];
    state.redoStack = [];
    noteUi.open.clear();
    state.pdfBytes = bytes;
    state.currentFilePath = files.length === 1 && isPdfName(files[0].name) ? files[0].name : null;
    state.fileHandle = state.currentFilePath ? fileHandle : null;
    state.currentPage = 0;
    ui.placeholder.hidden = true;
    ui.pageWrapper.hidden = false;
    enableControls(true);
    updateUndoRedoButtons();
    setModified(false);
    await reloadViewer();
}

async function loadOrMergeDroppedFiles(files) {
    try {
        if (!hasDocument()) {
            await loadNewDocument(files);
        } else {
            const insertAt = state.currentPage + 1;
            await editDocument(async doc => {
                let offset = 0;
                for (const file of files) {
                    offset += await insertFileIntoDoc(doc, file, insertAt + offset);
                }
            });
            setModified(true);
        }
    } catch (e) {
        console.error(e);
        await msgCritical('Error', `No se pudieron procesar los archivos arrastrados:\n${e.message || e}`);
    }
}

async function openSelectedFiles(files, fileHandle = null) {
    try {
        await loadNewDocument(files, fileHandle);
    } catch (e) {
        console.error(e);
        await msgCritical('Error', `No se pudo abrir el archivo:\n${e.message || e}`);
    }
}

/** Botón Abrir / Ctrl+O: si hay cambios sin guardar pregunta antes; el archivo elegido se abre desde cero. */
async function openFileOrImage() {
    if (isAnyDialogOpen()) return;
    commitTextEditor();
    commitImageEditor();
    await taskChain; // espera a que se apliquen las ediciones pendientes (p. ej. un texto en edición)

    if (hasDocument() && state.isModified) {
        const reply = await messageBox('question', 'Cambios sin guardar',
            '¿Deseas guardar los cambios del documento actual antes de abrir otro?', [
                { label: 'Guardar', value: 'save', isDefault: true },
                { label: 'No guardar', value: 'discard' },
                { label: 'Cancelar', value: 'cancel' }
            ], 'cancel');
        if (reply === 'cancel') return;
        if (reply === 'save') {
            let saved = false;
            await runTask(async () => { saved = await savePdf(); });
            if (!saved) return;
        }
    }
    if (window.showOpenFilePicker) {
        let handles;
        try {
            handles = await window.showOpenFilePicker({
                id: FILE_PICKER_ID, // recuerda la última carpeta usada
                multiple: true,
                types: [{
                    description: 'PDF o imágenes',
                    accept: {
                        'application/pdf': ['.pdf'],
                        'image/*': ['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.tiff', '.tif']
                    }
                }]
            });
        } catch (e) {
            if (e.name === 'AbortError') return;
            handles = null;
        }
        if (handles) {
            const files = await Promise.all(handles.map(h => h.getFile()));
            await runTask(() => openSelectedFiles(files, handles.length === 1 ? handles[0] : null));
            return;
        }
    }
    ui.fileOpen.value = '';
    ui.fileOpen.click();
}

function insertImageAsPage() {
    if (!hasDocument()) return;
    ui.fileImages.value = '';
    ui.fileImages.click();
}

function mergePdf() {
    if (!hasDocument()) return;
    ui.fileMerge.value = '';
    ui.fileMerge.click();
}

/* ---------- Visualización ---------- */

let renderToken = 0;
let currentRenderTask = null;
let thumbToken = 0;
const wordsCache = new Map();

/** Cambia el documento de pdf.js por el de los bytes actuales sin volver a dibujar la página (ediciones de notas). */
async function swapViewerDocQuietly() {
    const old = state.pdfJsDoc;
    state.pdfJsDoc = await pdfjsLib.getDocument({
        data: state.pdfBytes.slice(),
        cMapUrl: `${PDFJS_ASSETS}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${PDFJS_ASSETS}standard_fonts/`
    }).promise;
    wordsCache.clear();
    if (old) old.destroy();
}

async function reloadViewer() {
    const old = state.pdfJsDoc;
    state.pdfJsDoc = await pdfjsLib.getDocument({
        data: state.pdfBytes.slice(),
        cMapUrl: `${PDFJS_ASSETS}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${PDFJS_ASSETS}standard_fonts/`
    }).promise;
    wordsCache.clear();
    search.matches = []; // las coincidencias anteriores ya no valen; se vuelven a calcular abajo
    if (old) old.destroy();

    state.totalPages = state.pdfJsDoc.numPages;
    if (state.currentPage >= state.totalPages) state.currentPage = Math.max(0, state.totalPages - 1);
    ui.spinPage.max = String(state.totalPages);

    generateThumbnails();
    await renderCurrentPage();
    if (search.query) runSearch({ keepIndex: true });
}

function pageSizeLabel(widthMm, heightMm) {
    if (Math.abs(widthMm - 210) < 5 && Math.abs(heightMm - 297) < 5) return 'A4';
    if (Math.abs(widthMm - 215.9) < 5 && Math.abs(heightMm - 279.4) < 5) return 'Carta (Letter)';
    if (Math.abs(widthMm - 215.9) < 5 && Math.abs(heightMm - 355.6) < 5) return 'Oficio (Legal)';
    return 'Personalizado';
}

async function renderCurrentPage({ updateThumbnails = false } = {}) {
    if (!state.pdfJsDoc) return;
    commitTextEditor();
    commitImageEditor();

    ui.lblPageInfo.textContent = ` ${state.currentPage + 1} / ${state.totalPages} `;
    ui.spinPage.value = String(state.currentPage + 1);
    highlightCurrentThumbnail();
    ui.btnPrev.disabled = !(state.currentPage > 0);
    ui.btnNext.disabled = !(state.currentPage < state.totalPages - 1);

    const token = ++renderToken;
    const doc = state.pdfJsDoc;
    let page;
    try {
        page = await doc.getPage(state.currentPage + 1);
    } catch (e) {
        if (doc !== state.pdfJsDoc) return; // el documento se recargó mientras tanto
        throw e;
    }
    if (token !== renderToken) return;

    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: state.zoomFactor * dpr });
    const offscreen = document.createElement('canvas');
    offscreen.width = Math.ceil(viewport.width);
    offscreen.height = Math.ceil(viewport.height);

    if (currentRenderTask) currentRenderTask.cancel();
    const task = page.render({ canvasContext: offscreen.getContext('2d'), viewport });
    currentRenderTask = task;
    try {
        await task.promise;
    } catch (e) {
        if ((e && e.name === 'RenderingCancelledException') || doc !== state.pdfJsDoc) return;
        throw e;
    }
    if (token !== renderToken) return;

    const cssW = viewport.width / dpr;
    const cssH = viewport.height / dpr;
    for (const c of [ui.pageCanvas, ui.overlay]) {
        c.width = offscreen.width;
        c.height = offscreen.height;
        c.style.width = `${cssW}px`;
        c.style.height = `${cssH}px`;
    }
    ui.pageCanvas.getContext('2d').drawImage(offscreen, 0, 0);
    state.pageMapper = makePageMapper(page.view, page.rotate);
    refreshImageStampRects(page);
    renderSearchHighlights();
    renderNotes();

    const widthMm = state.pageMapper.width * 0.352778;
    const heightMm = state.pageMapper.height * 0.352778;
    const zoomPercent = Math.trunc(state.zoomFactor * 100);
    showStatus(
        `Página ${state.currentPage + 1} de ${state.totalPages}  |  ` +
        `Tamaño: ${widthMm.toFixed(0)} x ${heightMm.toFixed(0)} mm (${pageSizeLabel(widthMm, heightMm)})  |  ` +
        `Zoom: ${zoomPercent}%`
    );

    if (updateThumbnails) generateThumbnails();
    syncPageSlots(doc, token);
}

/* ---------- Vista de todas las páginas ---------- */

let slotDocId = 0;
const slotDocIds = new WeakMap();
let slotsToken = 0;
let lastScrolledPage = -1;

/**
 * Muestra todas las páginas apiladas. La página actual es la editable (contiene el
 * #page-wrapper); las demás son imágenes estáticas y al hacer clic pasan a ser la actual.
 */
async function syncPageSlots(doc, renderTok) {
    const container = ui.placeholder.parentElement;
    const token = ++slotsToken;
    if (!slotDocIds.has(doc)) slotDocIds.set(doc, ++slotDocId);
    const key = `${slotDocIds.get(doc)}|${state.zoomFactor}|${window.devicePixelRatio || 1}`;

    let slots = Array.from(container.querySelectorAll(':scope > .page-slot'));
    while (slots.length > doc.numPages) slots.pop().remove();
    while (slots.length < doc.numPages) {
        const slot = document.createElement('div');
        slot.className = 'page-slot';
        slot.addEventListener('click', () => {
            const i = Array.from(container.querySelectorAll(':scope > .page-slot')).indexOf(slot);
            if (i !== state.currentPage) {
                lastScrolledPage = i;
                state.currentPage = i;
                renderCurrentPage();
            }
        });
        container.appendChild(slot);
        slots.push(slot);
    }

    const cur = slots[state.currentPage];
    if (cur && ui.pageWrapper.parentElement !== cur) {
        const prev = ui.pageWrapper.parentElement;
        if (prev && prev.classList.contains('page-slot')) {
            prev.style.width = ui.pageCanvas.style.width;
            prev.style.height = ui.pageCanvas.style.height;
            prev.replaceChildren();
            delete prev.dataset.key;
        }
        cur.replaceChildren(ui.pageWrapper);
    }
    if (cur) { cur.classList.add('current'); delete cur.dataset.key; cur.style.width = cur.style.height = ''; }
    if (lastScrolledPage !== state.currentPage) {
        lastScrolledPage = state.currentPage;
        cur?.scrollIntoView({ block: 'nearest' });
    }

    const dpr = window.devicePixelRatio || 1;
    for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (i === state.currentPage) continue;
        slot.classList.remove('current');
        if (slot.dataset.key === key) continue;
        try {
            const page = await doc.getPage(i + 1);
            if (token !== slotsToken || renderTok !== renderToken) return;
            const viewport = page.getViewport({ scale: state.zoomFactor * dpr });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            canvas.style.width = `${viewport.width / dpr}px`;
            canvas.style.height = `${viewport.height / dpr}px`;
            slot.style.width = canvas.style.width;
            slot.style.height = canvas.style.height;
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            if (token !== slotsToken || renderTok !== renderToken) return;
            slot.replaceChildren(canvas);
            slot.dataset.key = key;
        } catch (e) {
            return; // el documento pudo recargarse mientras tanto
        }
    }
}

/* ---------- Miniaturas (DraggableThumbnailList) ---------- */

let thumbDragFrom = null;

function highlightCurrentThumbnail() {
    Array.from(ui.thumbList.children).forEach((el, i) => el.classList.toggle('selected', i === state.currentPage));
    const current = ui.thumbList.children[state.currentPage];
    if (current) current.scrollIntoView({ block: 'nearest' });
}

async function generateThumbnails() {
    const token = ++thumbToken;
    ui.thumbList.innerHTML = '';
    const doc = state.pdfJsDoc;
    if (!doc) return;

    const icons = [];
    for (let i = 0; i < doc.numPages; i++) {
        const item = document.createElement('div');
        item.className = 'thumb-item';
        item.draggable = true;
        const icon = document.createElement('div');
        icon.className = 'thumb-icon';
        const label = document.createElement('div');
        label.className = 'thumb-label';
        label.textContent = String(i + 1);
        item.append(icon, label);
        item.addEventListener('click', () => onThumbnailClicked(item));
        item.addEventListener('dragstart', e => {
            thumbDragFrom = Array.prototype.indexOf.call(ui.thumbList.children, item);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('application/x-pdf-thumb', String(thumbDragFrom));
        });
        item.addEventListener('dragend', () => {
            thumbDragFrom = null;
            clearThumbDropIndicator();
        });
        ui.thumbList.appendChild(item);
        icons.push(icon);
    }
    highlightCurrentThumbnail();
    await renderThumbnailCanvases(token, icons);
}

/**
 * Dibuja (o redibuja) las miniaturas con la resolución justa para el ancho actual
 * del panel, que el usuario puede cambiar arrastrando su borde.
 */
async function renderThumbnailCanvases(token, icons) {
    const doc = state.pdfJsDoc;
    const dpr = window.devicePixelRatio || 1;
    try {
        for (let i = 0; i < doc.numPages && i < icons.length; i++) {
            if (token !== thumbToken) return;
            const box = icons[i];
            const boxW = box.clientWidth || 110;
            const boxH = box.clientHeight || 150;
            const page = await doc.getPage(i + 1);
            const base = page.getViewport({ scale: 1 });
            const scale = Math.min(boxW / base.width, boxH / base.height);
            const viewport = page.getViewport({ scale: scale * dpr });
            const canvas = document.createElement('canvas');
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            if (token !== thumbToken) return;
            box.replaceChildren(canvas);
        }
    } catch (e) {
        // El documento pudo recargarse mientras se generaban las miniaturas.
    }
}

/** Tras cambiar el ancho del panel de miniaturas se re-renderizan en la nueva resolución. */
window.addEventListener('thumbnails-resized', () => {
    if (!state.pdfJsDoc) return;
    const icons = Array.from(ui.thumbList.querySelectorAll('.thumb-icon'));
    if (icons.length) renderThumbnailCanvases(++thumbToken, icons);
});

function onThumbnailClicked(item) {
    const pageNum = Array.prototype.indexOf.call(ui.thumbList.children, item);
    if (pageNum !== state.currentPage) {
        state.currentPage = pageNum;
        renderCurrentPage();
    }
}

function thumbInsertionIndex(clientY) {
    const items = Array.from(ui.thumbList.children);
    for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect();
        if (clientY < r.top + r.height / 2) return i;
    }
    return items.length;
}

function clearThumbDropIndicator() {
    ui.thumbList.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
}

ui.thumbList.addEventListener('dragover', e => {
    if (thumbDragFrom === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearThumbDropIndicator();
    const idx = thumbInsertionIndex(e.clientY);
    const items = ui.thumbList.children;
    if (idx < items.length) items[idx].classList.add('drop-before');
    else if (items.length) items[items.length - 1].classList.add('drop-after');
});

ui.thumbList.addEventListener('drop', e => {
    if (thumbDragFrom === null) return;
    e.preventDefault();
    e.stopPropagation();
    const from = thumbDragFrom;
    const insertion = thumbInsertionIndex(e.clientY);
    thumbDragFrom = null;
    clearThumbDropIndicator();
    const to = insertion > from ? insertion - 1 : insertion;
    if (to === from) return;
    const order = [];
    for (let i = 0; i < state.totalPages; i++) order.push(i);
    order.splice(from, 1);
    order.splice(to, 0, from);
    runTask(() => onPagesReordered(order, to));
});

async function onPagesReordered(newPageOrder, newCurrentRow) {
    if (!hasDocument()) return;
    await editDocument(doc => reorderDocument(doc, newPageOrder), { newPage: newCurrentRow });
}

/* ---------- Edición con historial (save_state_for_undo / undo / redo) ---------- */

function pushUndoState(bytes, page) {
    state.undoStack.push({ bytes, page });
    if (state.undoStack.length > state.maxHistory) state.undoStack.shift();
    state.redoStack = [];
    updateUndoRedoButtons();
    setModified(true);
}

/**
 * Aplica una modificación al documento: `mutator(doc)` recibe un PDFDocument de pdf-lib.
 * Si devuelve `false` no se registra ningún cambio; si devuelve otro PDFDocument, ese pasa a ser el documento.
 */
async function editDocument(mutator, { newPage = null, undoFrom = null, silent = false } = {}) {
    const prevBytes = undoFrom ? undoFrom.bytes : state.pdfBytes;
    const prevPage = undoFrom ? undoFrom.page : state.currentPage;
    const doc = await loadLibDoc(state.pdfBytes);
    const result = await mutator(doc);
    if (result === false) return false;
    const outDoc = result instanceof PDFDocument ? result : doc;
    const newBytes = await outDoc.save();

    pushUndoState(prevBytes, prevPage);
    state.pdfBytes = newBytes;
    if (newPage !== null) state.currentPage = newPage;
    // silent: la interfaz ya refleja el cambio (notas); sólo se actualiza el documento de pdf.js
    if (silent) await swapViewerDocQuietly();
    else await reloadViewer();
    return true;
}

async function undoAction() {
    if (!state.undoStack.length || !hasDocument()) return;
    state.redoStack.push({ bytes: state.pdfBytes, page: state.currentPage });
    const prev = state.undoStack.pop();
    state.pdfBytes = prev.bytes;
    state.currentPage = prev.page;
    await reloadViewer();
    updateUndoRedoButtons();
    setModified(state.undoStack.length > 0);
}

async function redoAction() {
    if (!state.redoStack.length || !hasDocument()) return;
    state.undoStack.push({ bytes: state.pdfBytes, page: state.currentPage });
    const next = state.redoStack.pop();
    state.pdfBytes = next.bytes;
    state.currentPage = next.page;
    await reloadViewer();
    updateUndoRedoButtons();
    setModified(true);
}

function updateUndoRedoButtons() {
    ui.btnUndo.disabled = state.undoStack.length === 0;
    ui.btnRedo.disabled = state.redoStack.length === 0;
}

/* ---------- Navegación y zoom ---------- */

function prevPage() {
    if (state.currentPage > 0) {
        state.currentPage -= 1;
        renderCurrentPage();
    }
}

function nextPage() {
    if (state.currentPage < state.totalPages - 1) {
        state.currentPage += 1;
        renderCurrentPage();
    }
}

function prevPageShortcut() {
    if (state.currentMode === 'navigate') prevPage();
}

function nextPageShortcut() {
    if (state.currentMode === 'navigate') nextPage();
}

function goToPage(pageNumber) {
    state.currentPage = pageNumber - 1;
    renderCurrentPage();
}

function zoomIn() {
    commitTextEditor();
    commitImageEditor();
    state.zoomFactor += 0.25;
    renderCurrentPage();
}

function zoomOut() {
    commitTextEditor();
    commitImageEditor();
    if (state.zoomFactor > 0.5) {
        state.zoomFactor -= 0.25;
        renderCurrentPage();
    }
}

/* ---------- Modos, color y grosor ---------- */

function colorToHex(c) {
    return '#' + c.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function setBrushColor(color) {
    state.brushColor = color;
    ui.btnColor.style.backgroundColor = colorToHex(color);
}

/**
 * Color y grosor por herramienta (valores por defecto). Cada herramienta recuerda
 * los cambios que el usuario le haga mientras la app esté abierta.
 */
const TOOL_DEFAULTS = {
    highlight: { color: [1.0, 1.0, 0.0] },
    underline: { color: [0.0, 0.0, 0.0] },
    strike: { color: [0.0, 0.0, 0.0] },
    draw: { color: [0.0, 0.0, 0.0], width: 5 },
    rect: { color: [0.0, 0.0, 0.0], width: 3 },
    arrow: { color: [0.0, 0.0, 0.0], width: 3 },
    line: { color: [0.0, 0.0, 0.0], width: 3 },
};
const toolSettings = JSON.parse(JSON.stringify(TOOL_DEFAULTS));

function setMode(mode) {
    hidePasteHint();
    commitTextEditor();
    commitImageEditor();
    state.currentMode = mode;
    const settings = toolSettings[mode];
    if (settings) {
        setBrushColor(settings.color.slice());
        if (settings.width !== undefined) {
            changeBrushWidth(settings.width);
            ui.spinWidth.value = String(settings.width);
        }
    }
    ui.overlay.dataset.mode = mode;
    ui.btnQrValidate.classList.toggle('active', mode === 'qr');
    setTextFormatBarVisible(mode === 'text');
}

/** Activa/desactiva la herramienta Validar QR (no pertenece a la barra de edición, así que se destildan sus radios). */
function toggleQrTool() {
    if (state.currentMode === 'qr') {
        selectModeRadio('navigate');
        return;
    }
    document.querySelectorAll('input[name="mode"]').forEach(r => { r.checked = false; });
    setMode('qr');
    showStatus('Validar QR: dibujá un recuadro sobre el código QR de la factura.', 6000, 'qr-code');
}

/** Lee el QR del área marcada y abre la página de AFIP/ARCA para validar la factura. */
async function validateQrInRect(screenRect) {
    if (typeof jsQR !== 'function') {
        showStatus('No se pudo cargar el lector de QR (jsQR). Revisá la conexión a internet y recargá la página.', 8000, 'warning');
        return;
    }
    const canvas = await renderPageRegion(state.currentPage, screenRect, 300);
    if (!canvas) return;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const code = typeof jsQR === 'function' ? jsQR(data.data, data.width, data.height, { inversionAttempts: 'attemptBoth' }) : null;
    if (!code || !code.data) {
        showStatus('No se detectó ningún código QR en esa área. Probá encuadrándolo mejor.', 6000, 'warning');
        return;
    }
    let url;
    try { url = new URL(code.data.trim()); } catch (e) { url = null; }
    if (!url || !/(^|\.)(afip|arca)\.gob\.ar$/i.test(url.hostname) || url.protocol !== 'https:') {
        showStatus(`El QR no es de AFIP/ARCA: "${code.data.slice(0, 80)}"`, 8000, 'warning');
        return;
    }
    window.open(url.href, '_blank', 'noopener');
    showStatus('QR leído. Se abrió la página de validación de AFIP/ARCA.', 6000, 'check-circle');
    selectModeRadio('navigate');
}

function selectModeRadio(mode) {
    const radio = document.querySelector(`input[name="mode"][value="${mode}"]`);
    if (radio) radio.checked = true;
    setMode(mode);
}

function chooseColor() {
    ui.colorInput.value = colorToHex(state.brushColor).toLowerCase();
    ui.colorInput.click();
}

function changeBrushWidth(width) {
    state.brushWidth = width;
    state.fontSize = width;
}

/* ---------- Operaciones de página ---------- */

async function rotatePage(angle) {
    if (!hasDocument()) return;
    await editDocument(doc => {
        const page = doc.getPage(state.currentPage);
        page.setRotation(degrees((((page.getRotation().angle + angle) % 360) + 360) % 360));
    });
}

async function deleteCurrentPage() {
    if (!hasDocument() || state.totalPages <= 1) {
        await msgWarning('Aviso', 'No se puede eliminar la única página del documento.');
        return;
    }
    const reply = await msgQuestionYesNo('Confirmar eliminación',
        `¿Estás seguro de que deseas eliminar la página ${state.currentPage + 1}?`);
    if (reply === 'yes') {
        await editDocument(doc => { doc.removePage(state.currentPage); });
    }
}

/** Inserta una hoja en blanco (del mismo tamaño que la página actual) justo después de ella. */
async function insertBlankPage() {
    if (!hasDocument()) return;
    const insertPos = state.currentPage + 1;
    const { width, height } = state.pageMapper || { width: A4.w, height: A4.h };
    await editDocument(doc => { doc.insertPage(insertPos, [width, height]); }, { newPage: insertPos });
}

async function openGridView() {
    if (!hasDocument()) return;
    // Mientras el diálogo está abierto no hay ningún proceso en curso: sin cursor de espera
    document.body.classList.remove('busy');
    const newOrder = await new GridViewDialog(state.pdfJsDoc).open();
    document.body.classList.add('busy'); // runTask lo quita al terminar
    if (!newOrder) return;
    const originalOrder = Array.from({ length: state.totalPages }, (_, i) => i);
    if (newOrder.join(',') !== originalOrder.join(',')) {
        const newTotal = newOrder.length;
        await editDocument(doc => reorderDocument(doc, newOrder), {
            newPage: state.currentPage >= newTotal ? Math.max(0, newTotal - 1) : state.currentPage
        });
        setModified(true);
    }
}

function parsePageRange(input, total) {
    const selected = new Set();
    for (let part of input.split(',')) {
        part = part.trim();
        if (part.includes('-')) {
            const pieces = part.split('-');
            if (pieces.length !== 2) throw new Error('rango');
            const start = parseStrictInt(pieces[0]);
            const end = parseStrictInt(pieces[1]);
            for (let p = start; p <= end; p++) {
                if (p >= 1 && p <= total) selected.add(p - 1);
            }
        } else {
            const p = parseStrictInt(part);
            if (p >= 1 && p <= total) selected.add(p - 1);
        }
    }
    return Array.from(selected).sort((a, b) => a - b);
}

function parseStrictInt(text) {
    const t = text.trim();
    if (!/^[+-]?\d+$/.test(t)) throw new Error('número');
    return parseInt(t, 10);
}

async function extractPages() {
    if (!hasDocument()) return;
    const dialogText =
        `Introduce el rango de páginas a extraer (1 - ${state.totalPages}).\n` +
        "Ejemplos: '3', '1-5', '1, 3, 5-7'";
    const inputRange = await inputDialog('Extraer Páginas', dialogText, { defaultValue: String(state.currentPage + 1) });
    if (inputRange === null || !inputRange.trim()) return;

    let sortedPages;
    try {
        sortedPages = parsePageRange(inputRange, state.totalPages);
    } catch (e) {
        await msgWarning('Formato Inválido', "Introduce un rango válido. Ejemplo: '1-3, 5'");
        return;
    }
    if (!sortedPages.length) return;

    try {
        const saved = await saveBytesAs('paginas_extraidas.pdf', async () => {
            const doc = await loadLibDoc(state.pdfBytes);
            const extracted = await extractPagesToNewDoc(doc, sortedPages);
            return extracted.save();
        });
        if (saved) await msgInfo('Éxito', `Se extrajeron ${sortedPages.length} página(s) correctamente.`);
    } catch (e) {
        await msgCritical('Error', `No se pudieron extraer las páginas:\n${e.message || e}`);
    }
}

/** Guardar: sobrescribe el archivo abierto/guardado; si no hay ubicación conocida, actúa como Guardar como. */
async function savePdf() {
    return writePdf(false);
}

/** Guardar como: siempre pide nombre y ubicación. */
async function savePdfAs() {
    return writePdf(true);
}

async function writePdf(forceAs) {
    if (!hasDocument()) return false;
    try {
        const bytes = state.pdfBytes;
        let saved = null;
        if (!forceAs && state.fileHandle) {
            try {
                const writable = await state.fileHandle.createWritable();
                await writable.write(bytes);
                await writable.close();
                saved = state.fileHandle.name;
            } catch (e) {
                if (e.name === 'AbortError') return false;
                state.fileHandle = null; // sin permiso o archivo no accesible: se pide ubicación
            }
        }
        if (!saved) {
            saved = await saveBytesAs(state.currentFilePath || 'documento.pdf', async () => bytes,
                h => { state.fileHandle = h; });
        }
        if (!saved) return false;
        state.currentFilePath = saved;
        setModified(false);
        await msgInfo('Éxito', 'El PDF se guardó correctamente.');
        return true;
    } catch (e) {
        await msgCritical('Error', `No se pudo guardar el archivo:\n${e.message || e}`);
        return false;
    }
}

/* ---------- Renderizado a imagen (exportar / imprimir / recortar / OCR) ---------- */

async function renderPageToCanvas(pageIndex, dpi) {
    const page = await state.pdfJsDoc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return canvas;
}

/** Renderiza solo una región (coordenadas de pantalla a zoom 1) de la página, como get_pixmap(clip=..., dpi=...). */
async function renderPageRegion(pageIndex, rect, dpi) {
    const page = await state.pdfJsDoc.getPage(pageIndex + 1);
    const scale = dpi / 72;
    const viewport = page.getViewport({ scale });
    const sx = Math.max(0, Math.floor(rect.x0 * scale));
    const sy = Math.max(0, Math.floor(rect.y0 * scale));
    const ex = Math.min(Math.floor(viewport.width), Math.ceil(rect.x1 * scale));
    const ey = Math.min(Math.floor(viewport.height), Math.ceil(rect.y1 * scale));
    if (ex <= sx || ey <= sy) return null;
    const canvas = document.createElement('canvas');
    canvas.width = ex - sx;
    canvas.height = ey - sy;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: [1, 0, 0, 1, -sx, -sy] }).promise;
    return canvas;
}

async function exportToImages() {
    if (!hasDocument()) return;
    const opts = await exportImageDialog(state.totalPages, state.currentPage);
    if (!opts) return;

    const fmt = opts.format;
    const mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
    const pagesToExport = opts.allPages
        ? Array.from({ length: state.totalPages }, (_, i) => i)
        : [state.currentPage];
    const baseName = state.currentFilePath ? baseNameWithoutExt(state.currentFilePath) : 'pagina';

    // Seleccionar carpeta de destino (si el navegador lo permite)
    let dirHandle = null;
    let useDownload = true;
    if (window.showDirectoryPicker) {
        try {
            dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
            useDownload = false;
        } catch (e) {
            if (e.name === 'AbortError') return;
        }
    }

    try {
        const files = [];
        for (const pageIdx of pagesToExport) {
            showStatus(`Exportando página ${pageIdx + 1}...`);
            const canvas = await renderPageToCanvas(pageIdx, opts.dpi);
            const blob = await canvasToBlob(canvas, mime);
            files.push({ name: `${baseName}_p${pageIdx + 1}.${fmt}`, blob });
        }

        let destination;
        if (!useDownload) {
            for (const f of files) {
                const fh = await dirHandle.getFileHandle(f.name, { create: true });
                const writable = await fh.createWritable();
                await writable.write(f.blob);
                await writable.close();
            }
            destination = dirHandle.name;
        } else if (files.length === 1) {
            downloadBlob(files[0].blob, files[0].name);
            destination = 'Descargas';
        } else {
            const zip = new JSZip();
            files.forEach(f => zip.file(f.name, f.blob));
            downloadBlob(await zip.generateAsync({ type: 'blob' }), `${baseName}_imagenes.zip`);
            destination = `Descargas (${baseName}_imagenes.zip)`;
        }
        renderCurrentPage();
        await msgInfo('Exportación Exitosa',
            `Se exportaron ${files.length} página(s) correctamente en la carpeta:\n${destination}`);
    } catch (e) {
        renderCurrentPage();
        await msgCritical('Error', `No se pudieron exportar las imágenes:\n${e.message || e}`);
    }
}

async function printPdf() {
    if (!hasDocument()) return;
    const urls = [];
    ui.printArea.innerHTML = '';
    try {
        for (let i = 0; i < state.totalPages; i++) {
            showStatus(`Preparando impresión: página ${i + 1} de ${state.totalPages}...`);
            const canvas = await renderPageToCanvas(i, 300);
            const url = URL.createObjectURL(await canvasToBlob(canvas, 'image/png'));
            urls.push(url);
            const img = document.createElement('img');
            img.src = url;
            ui.printArea.appendChild(img);
        }
        await Promise.all(Array.from(ui.printArea.querySelectorAll('img')).map(img => img.decode().catch(() => {})));
        renderCurrentPage();
        window.print();
        await msgInfo('Éxito', 'El trabajo de impresión se envió correctamente.');
    } catch (e) {
        renderCurrentPage();
        await msgCritical('Error', 'No se pudo iniciar la impresión.');
    } finally {
        ui.printArea.innerHTML = '';
        urls.forEach(u => URL.revokeObjectURL(u));
    }
}

/* ---------- Firma / marca de agua ---------- */

/* Cada firma cargada queda como un botón debajo del menú vertical; se estampa arrastrándolo a la hoja. */

async function configureStamp() {
    if (!hasDocument()) return;
    const result = await stampDialog(state.signatures.map(s => s.name));
    if (!result) return;

    let image;
    try {
        const images = await fileToImages(result.file);
        image = images[0];
        if (!image.width) {
            const bitmap = await createImageBitmap(result.file);
            image.width = bitmap.width;
            image.height = bitmap.height;
            bitmap.close();
        }
    } catch (e) {
        await msgWarning('Aviso', 'Por favor, selecciona un archivo de imagen válido.');
        return;
    }

    const aspectRatio = image.width > 0 ? image.height / image.width : 1.0;
    const signature = {
        name: result.name,
        image,
        width: result.width,
        height: result.width * aspectRatio,
        url: URL.createObjectURL(new Blob([image.bytes], { type: image.type === 'jpg' ? 'image/jpeg' : 'image/png' }))
    };
    state.signatures.push(signature);
    addSignatureButton(signature);

    if (result.allPages) {
        await applyWatermarkToAllPages(signature);
    } else {
        showStatus(`Firma "${signature.name}" cargada. Arrástrala a la hoja para estamparla.`, 7000, 'signature');
    }
}

async function applyWatermarkToAllPages(signature) {
    if (!hasDocument() || !signature) return;
    const { image, width, height } = signature;

    await editDocument(async doc => {
        const embedded = await embedImage(doc, image);
        for (const page of doc.getPages()) {
            const mapper = mapperForLibPage(page);
            const x0 = (mapper.width - width) / 2;
            const y0 = (mapper.height - height) / 2;
            drawImageInScreenRect(doc, page, embedded.ref, mapper, x0, y0, width, height);
        }
    });
    await msgInfo('Éxito', 'Marca de agua aplicada a todas las páginas.');
}

/** Botón flotante con el nombre de la firma (se agrega debajo de los anteriores). */
function addSignatureButton(signature) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'signature-chip';
    btn.title = `Arrastra la firma "${signature.name}" a la hoja para estamparla`;
    btn.innerHTML = icon('signature');
    btn.append(` ${signature.name}`);
    btn.addEventListener('pointerdown', e => onSignaturePointerDown(e, signature, btn));
    ui.signatureList.appendChild(btn);
    gsap.from(btn, { autoAlpha: 0, x: 16, duration: 0.25, ease: 'power2.out' });
}

/** Arrastre de un botón de firma: una vista previa sigue al mouse y al soltarla sobre la hoja se incrusta ahí. */
function onSignaturePointerDown(e, signature, btn) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    let ghost = null;

    const overPage = ev => {
        if (!hasDocument() || !state.pageMapper) return false;
        const r = ui.pageCanvas.getBoundingClientRect();
        const v = ui.scrollArea.getBoundingClientRect();
        return ev.clientX >= Math.max(r.left, v.left) && ev.clientX <= Math.min(r.right, v.right) &&
               ev.clientY >= Math.max(r.top, v.top) && ev.clientY <= Math.min(r.bottom, v.bottom);
    };

    const onMove = ev => {
        if (!ghost) {
            if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
            // Vista previa al tamaño con el que quedará en la página (según el zoom actual)
            ghost = document.createElement('img');
            ghost.className = 'signature-ghost';
            ghost.src = signature.url;
            ghost.style.width = `${signature.width * state.zoomFactor}px`;
            ghost.style.height = `${signature.height * state.zoomFactor}px`;
            document.body.appendChild(ghost);
            document.body.classList.add('dragging-signature');
            gsap.fromTo(ghost, { scale: 0.6, autoAlpha: 0 }, { scale: 1, autoAlpha: 0.85, duration: 0.15, ease: 'power2.out' });
        }
        gsap.set(ghost, { left: ev.clientX, top: ev.clientY, xPercent: -50, yPercent: -50 });
        ghost.classList.toggle('invalid', !overPage(ev));
    };

    const onUp = ev => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        document.body.classList.remove('dragging-signature');
        if (!ghost) {
            showStatus(`Arrastra el botón "${signature.name}" hasta la hoja para estampar la firma.`, 5000, 'signature');
            return;
        }
        if (ev.type === 'pointerup' && overPage(ev)) {
            ghost.remove();
            const r = ui.pageCanvas.getBoundingClientRect();
            const center = { x: (ev.clientX - r.left) / state.zoomFactor, y: (ev.clientY - r.top) / state.zoomFactor };
            const { bytes, type } = signature.image;
            runTask(async () => openImageEditor({ bytes, type, w: signature.width, h: signature.height }, { center }));
        } else {
            // Soltada fuera de la hoja: vuelve al botón y desaparece
            const b = btn.getBoundingClientRect();
            gsap.to(ghost, {
                left: b.left + b.width / 2, top: b.top + b.height / 2, scale: 0.3, autoAlpha: 0,
                duration: 0.25, ease: 'power2.in', onComplete: () => ghost.remove()
            });
        }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
}

/* ---------- Herramientas de anotación ---------- */

/* ---------- Editor de texto sobre la página ---------- */

// Último estilo usado: el próximo texto nuevo arranca con estos valores (se recuerda entre sesiones)
const TEXT_STYLE_KEYS = ['family', 'bold', 'italic', 'strike', 'fontSize', 'color'];
const textStyle = { family: 'He', bold: false, italic: false, strike: false, fontSize: 14, color: [0, 0, 0] };
try {
    const saved = JSON.parse(localStorage.getItem('textStyle') || 'null');
    if (saved && TEXT_FONT_FAMILIES[saved.family]) {
        TEXT_STYLE_KEYS.forEach(k => { if (saved[k] !== undefined) textStyle[k] = saved[k]; });
    }
} catch (e) { /* sin almacenamiento: valores por defecto */ }

let textEditor = null;          // editor abierto: { el, box, family, bold, italic, strike, fontSize, color, page, undoFrom }

const pickTextStyle = src => Object.fromEntries(TEXT_STYLE_KEYS.map(k => [k, src[k]]));

/**
 * Cambia el estilo del texto desde cualquiera de las dos barras (la flotante del cuadro o la
 * superior). Se aplica al cuadro abierto, queda como estilo de los textos nuevos y se sincronizan
 * los controles de ambas barras.
 */
function updateTextStyle(changes) {
    if (textEditor) {
        // El cuadro que se está editando pasa a ser "el último texto": su formato completo queda para los nuevos
        Object.assign(textEditor, changes);
        Object.assign(textStyle, pickTextStyle(textEditor));
        applyTextEditorStyle();
    } else {
        Object.assign(textStyle, changes);
    }
    try { localStorage.setItem('textStyle', JSON.stringify(textStyle)); } catch (e) { /* opcional */ }
    if (changes.family !== undefined || changes.bold !== undefined || changes.italic !== undefined) {
        // Se precarga la fuente mientras dura el gesto del usuario (permiso de fuentes locales)
        loadTextFontBytes(textStyle.family, fontVariantIndex(textStyle.bold, textStyle.italic)).catch(() => {});
    }
    syncTextControls();
}

/** Controles de estilo de texto dentro de `root` (barra flotante o superior). */
function textControlsIn(root) {
    return {
        font: root.querySelector('.text-font'),
        size: root.querySelector('.text-size'),
        color: root.querySelector('.text-color'),
        toggles: root.querySelectorAll('.text-toggle')
    };
}

function syncTextControls() {
    const src = textEditor || textStyle;
    const roots = [ui.textFormatBar];
    if (textEditor) roots.push(textEditor.el.querySelector('.text-toolbar'));
    for (const root of roots) {
        const c = textControlsIn(root);
        c.font.value = src.family;
        c.font.style.fontFamily = TEXT_FONT_FAMILIES[src.family].css;
        if (document.activeElement !== c.size) c.size.value = String(src.fontSize);
        c.color.value = colorToHex(src.color).toLowerCase();
        c.toggles.forEach(b => {
            const on = !!src[b.dataset.style];
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', String(on));
        });
    }
}

/** HTML de los controles de fuente / tamaño / color / negrita-cursiva-tachado. */
function textControlsHtml() {
    return `
        <select class="text-font" title="Fuente">
            ${Object.entries(TEXT_FONT_FAMILIES).map(([k, f]) => `<option value="${k}" style="font-family: ${f.css.replace(/"/g, '&quot;')}">${f.label}</option>`).join('')}
        </select>
        <input type="number" class="text-size" min="4" max="200" step="1" title="Tamaño (pt)">
        <input type="color" class="text-color" title="Color del texto">
        <span class="text-toggles">
            <button type="button" class="text-toggle" data-style="bold" title="Negrita (Ctrl+B)" aria-pressed="false">${icon('text-b')}</button>
            <button type="button" class="text-toggle" data-style="italic" title="Cursiva (Ctrl+I)" aria-pressed="false">${icon('text-italic')}</button>
            <button type="button" class="text-toggle" data-style="strike" title="Tachado" aria-pressed="false">${icon('text-strikethrough')}</button>
        </span>`;
}

/** Conecta los controles de `root` con updateTextStyle. */
function bindTextControls(root) {
    const c = textControlsIn(root);
    const refocus = () => { if (textEditor) textEditor.box.focus(); };
    c.font.addEventListener('change', () => { updateTextStyle({ family: c.font.value }); refocus(); });
    c.size.addEventListener('input', () => {
        const v = parseFloat(c.size.value);
        if (!Number.isNaN(v) && v >= 4 && v <= 200) updateTextStyle({ fontSize: v });
    });
    c.size.addEventListener('change', () => { syncTextControls(); });
    c.color.addEventListener('input', () => {
        const hex = c.color.value;
        updateTextStyle({ color: [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) });
    });
    c.toggles.forEach(b => {
        // mousedown sin foco: el cursor sigue en el cuadro de texto
        b.addEventListener('mousedown', e => e.preventDefault());
        b.addEventListener('click', () => {
            const key = b.dataset.style;
            updateTextStyle({ [key]: !(textEditor || textStyle)[key] });
            refocus();
        });
    });
}

/** Barra de formato de texto a la derecha de la barra superior (sólo con la herramienta Texto). */
function initTextFormatBar() {
    ui.textFormatBar.innerHTML = textControlsHtml();
    bindTextControls(ui.textFormatBar);
    syncTextControls();
}

function setTextFormatBarVisible(show) {
    const bar = ui.textFormatBar;
    if (show === !bar.hidden) return;
    gsap.killTweensOf(bar);
    if (show) {
        syncTextControls();
        bar.hidden = false;
        gsap.fromTo(bar, { autoAlpha: 0, x: 12 }, { autoAlpha: 1, x: 0, duration: 0.25, ease: 'power2.out' });
        gsap.fromTo(bar.children, { autoAlpha: 0, y: -4 }, { autoAlpha: 1, y: 0, duration: 0.2, stagger: 0.03, ease: 'power2.out' });
    } else {
        gsap.to(bar, { autoAlpha: 0, x: 12, duration: 0.15, ease: 'power1.in', onComplete: () => { bar.hidden = true; } });
    }
}
let textEditorClosedByClick = false;

/**
 * Clic en modo Texto: si se tocó un texto existente se reabre para editarlo;
 * si no, se crea un cuadro nuevo en ese punto.
 */
async function beginTextAt(screenPt) {
    const pdfPt = state.pageMapper.toPdf(screenPt.x, screenPt.y);
    const prev = { bytes: state.pdfBytes, page: state.currentPage };
    const doc = await loadLibDoc(state.pdfBytes);
    const found = takeFreeTextAt(doc, doc.getPage(state.currentPage), pdfPt);

    if (found) {
        // Se quita temporalmente la anotación para editarla; el historial apunta al estado previo.
        state.pdfBytes = await doc.save();
        await reloadViewer();
        const box = state.pageMapper.rectToScreen(found.rect);
        openTextEditor({
            x: box.x0, y: box.y0,
            text: found.text,
            style: { family: found.family, bold: found.bold, italic: found.italic, strike: found.strike, fontSize: found.fontSize, color: found.color },
            undoFrom: prev
        });
    } else {
        openTextEditor({ x: screenPt.x, y: screenPt.y - textStyle.fontSize * 0.6, text: '', style: pickTextStyle(textStyle), undoFrom: null });
    }
}

function openTextEditor({ x, y, text, style, undoFrom }) {
    const el = document.createElement('div');
    el.className = 'text-editor';
    el.innerHTML = `
        <div class="text-toolbar">
            <span class="text-grip" title="Arrastra para mover el texto">${icon("arrows-out-cardinal")}</span>
            ${textControlsHtml()}
            <button type="button" class="text-ok" title="Aplicar (Ctrl+Enter)">${icon("check")}</button>
            <button type="button" class="text-del" title="Eliminar texto">${icon("trash")}</button>
        </div>
        <div class="text-box" contenteditable="true" spellcheck="false"></div>
    `;
    ui.pageWrapper.appendChild(el);

    const box = el.querySelector('.text-box');
    box.textContent = text;

    textEditor = { el, box, ...style, page: state.currentPage, undoFrom };
    applyTextEditorStyle();
    placeTextEditor(x, y);
    bindTextControls(el.querySelector('.text-toolbar'));
    syncTextControls();

    el.querySelector('.text-ok').addEventListener('click', () => commitTextEditor());
    el.querySelector('.text-del').addEventListener('click', () => {
        box.textContent = '';
        commitTextEditor();
    });

    // Pegar siempre como texto plano
    box.addEventListener('paste', e => {
        e.preventDefault();
        const plain = (e.clipboardData || window.clipboardData).getData('text/plain');
        document.execCommand('insertText', false, plain);
    });
    box.addEventListener('keydown', e => {
        const ctrl = e.ctrlKey || e.metaKey;
        const lower = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        if (e.key === 'Escape') { e.preventDefault(); cancelTextEditor(); }
        else if (e.key === 'Enter' && ctrl) { e.preventDefault(); commitTextEditor(); }
        // Negrita / cursiva afectan a todo el cuadro (evita que el navegador inserte <b>/<i>)
        else if (ctrl && lower === 'b') { e.preventDefault(); updateTextStyle({ bold: !textEditor.bold }); }
        else if (ctrl && lower === 'i') { e.preventDefault(); updateTextStyle({ italic: !textEditor.italic }); }
        else if (ctrl && lower === 'u') { e.preventDefault(); }
    });

    // Mover con arrastrar y soltar: desde el ícono ✥ o desde el borde del cuadro
    el.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        // closest(): el clic suele caer en el <svg>/<path> del ícono, no en el span
        if (!(e.target === el || e.target.closest('.text-grip'))) return;
        e.preventDefault();
        const startX = e.clientX, startY = e.clientY;
        const startLeft = el.offsetLeft, startTop = el.offsetTop;
        el.classList.add('moving');
        el.setPointerCapture(e.pointerId);
        const onMove = ev => {
            const maxL = ui.pageCanvas.offsetWidth - 20;
            const maxT = ui.pageCanvas.offsetHeight - 20;
            el.style.left = `${Math.min(maxL, Math.max(-el.offsetWidth + 20, startLeft + ev.clientX - startX))}px`;
            el.style.top = `${Math.min(maxT, Math.max(0, startTop + ev.clientY - startY))}px`;
            updateToolbarSide();
        };
        const onUp = () => {
            el.classList.remove('moving');
            el.removeEventListener('pointermove', onMove);
            el.removeEventListener('pointerup', onUp);
            el.removeEventListener('pointercancel', onUp);
            box.focus();
        };
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
    });

    box.focus();
    placeCaretAtEnd(box);
    showStatus('Escribe el texto. Arrástralo desde el ícono de mover o el borde para moverlo. Clic fuera o en el botón de aplicar para aplicar, Esc para cancelar.', 0, 'note-pencil');
}

function applyTextEditorStyle() {
    const { box, family, bold, italic, strike, fontSize, color } = textEditor;
    box.style.fontFamily = (TEXT_FONT_FAMILIES[family] || TEXT_FONT_FAMILIES.He).css;
    box.style.fontWeight = bold ? 'bold' : 'normal';
    box.style.fontStyle = italic ? 'italic' : 'normal';
    box.style.textDecoration = strike ? 'line-through' : 'none';
    box.style.fontSize = `${fontSize * state.zoomFactor}px`;
    box.style.padding = `${FREETEXT_PAD * state.zoomFactor}px`;
    box.style.color = colorToHex(color);
}

/** Ubica el editor para que el área de texto empiece en el punto de pantalla (x, y). */
function placeTextEditor(x, y) {
    const { el, box } = textEditor;
    el.style.left = '0px';
    el.style.top = '0px';
    const offX = box.offsetLeft, offY = box.offsetTop;
    el.style.left = `${x * state.zoomFactor - offX}px`;
    el.style.top = `${Math.max(0, y * state.zoomFactor - offY)}px`;
    updateToolbarSide();
}

/** Si el cuadro está cerca del borde superior, la barra de opciones se muestra debajo. */
function updateToolbarSide() {
    const { el } = textEditor;
    el.classList.toggle('toolbar-below', el.offsetTop < 40);
}

function placeCaretAtEnd(node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}

function closeTextEditor() {
    const ed = textEditor;
    textEditor = null;
    if (ed) ed.el.remove();
    return ed;
}

/** Aplica el texto al PDF (o lo elimina si quedó vacío). */
function commitTextEditor() {
    if (!textEditor) return;
    const { box, fontSize, color, page, undoFrom } = textEditor;
    const style = { family: textEditor.family, bold: textEditor.bold, italic: textEditor.italic, strike: textEditor.strike };
    const text = box.innerText.replace(/ /g, ' ').replace(/\n+$/, '');
    const canvasRect = ui.pageCanvas.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    const x = (boxRect.left - canvasRect.left) / state.zoomFactor;
    const y = (boxRect.top - canvasRect.top) / state.zoomFactor;
    const mapper = state.pageMapper;
    closeTextEditor();
    showStatus('');

    if (!text.trim()) {
        // Texto vacío: si era uno existente queda eliminado (se registra en el historial)
        if (undoFrom) runTask(() => editDocument(() => {}, { undoFrom }));
        return;
    }
    runTask(() => editDocument(doc => addFreeTextAnnot(
        doc, doc.getPage(page), mapper, { x, y }, text, fontSize, color, style
    ), { undoFrom }));
}

/** Descarta los cambios del editor (un texto existente vuelve a su estado original). */
function cancelTextEditor() {
    const ed = closeTextEditor();
    showStatus('');
    if (ed && ed.undoFrom) {
        runTask(async () => {
            state.pdfBytes = ed.undoFrom.bytes;
            await reloadViewer();
        });
    }
}

async function addRectAnnotation(pdfRect) {
    if (!hasDocument()) return;
    await editDocument(doc => addRectAnnot(doc, doc.getPage(state.currentPage), pdfRect, state.brushColor, state.brushWidth));
}

async function addArrowAnnotation(p1, p2) {
    if (!hasDocument()) return;
    await editDocument(doc => addArrowAnnot(doc, doc.getPage(state.currentPage), p1, p2, state.brushColor, state.brushWidth));
}

async function applyAreaHighlight(selectionRect) {
    if (!hasDocument()) return;
    const words = await getPageWords(state.currentPage);
    const matching = words.filter(w => rectIntersects(selectionRect, w));
    await editDocument(doc => {
        const page = doc.getPage(state.currentPage);
        if (matching.length) addHighlightAnnot(doc, page, matching, state.brushColor);
        else addFilledRectAnnot(doc, page, selectionRect, state.brushColor, 0.4);
    });
}

async function addLineAnnotation(p1, p2) {
    if (!hasDocument()) return;
    await editDocument(doc => addLineAnnot(doc, doc.getPage(state.currentPage), p1, p2, state.brushColor, state.brushWidth));
}

async function deleteAnnotationAtPoint(pdfPt) {
    if (!hasDocument()) return;
    await editDocument(doc => deleteAnnotationAt(doc, doc.getPage(state.currentPage), pdfPt));
}

async function applyDrawing(points) {
    if (!hasDocument()) return;
    await editDocument(doc => addInkAnnot(doc, doc.getPage(state.currentPage), points, state.brushColor, state.brushWidth));
}

/** Borra un área tapándola con un rectángulo blanco opaco (anotación; la goma puede quitarla). */
async function applyEraseArea(pdfRect) {
    if (!hasDocument()) return;
    await editDocument(doc => addFilledRectAnnot(doc, doc.getPage(state.currentPage), pdfRect, [1, 1, 1], 1));
}

async function applyCropAsNewPage(screenRect) {
    if (!hasDocument()) return;
    const canvas = await renderPageRegion(state.currentPage, screenRect, 300);
    if (!canvas) return;
    const bytes = await canvasToPngBytes(canvas);
    const insertPos = state.currentPage + 1;
    await editDocument(doc => insertImageAsA4Page(doc, { bytes, type: 'png' }, insertPos), { newPage: insertPos });
}

/* ---------- Selección como imagen: copiar, pegar (Ctrl+V), mover y redimensionar ---------- */

const SELECTION_DPI = 300;

// Última área copiada con el modo Selección: { bytes, pxW, pxH, w, h } (w/h en puntos de página)
let imageClipboard = null;

// Imagen pegada que todavía se está ubicando: { el, bytes, type, x, y, w, h, page, mapper }
let imageEditor = null;

/**
 * Renderiza el área seleccionada, la guarda en el portapapeles interno y, si el
 * navegador lo permite, también en el portapapeles del sistema (para pegarla en otras apps).
 */
function copySelectionAsImage(screenRect) {
    const pageIndex = state.currentPage;
    let resolveBlob, rejectBlob;
    const blobPromise = new Promise((res, rej) => { resolveBlob = res; rejectBlob = rej; });
    blobPromise.catch(() => {});

    // Se escribe en el portapapeles dentro del gesto del usuario; la imagen llega cuando termina de renderizarse.
    if (navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
        try {
            navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]).catch(() => {});
        } catch (e) { /* solo queda el portapapeles interno */ }
    }

    runTask(async () => {
        try {
            const canvas = await renderPageRegion(pageIndex, screenRect, SELECTION_DPI);
            if (!canvas) throw new Error('Área vacía');
            const blob = await canvasToBlob(canvas, 'image/png');
            imageClipboard = {
                bytes: new Uint8Array(await blob.arrayBuffer()),
                pxW: canvas.width,
                pxH: canvas.height,
                w: canvas.width * 72 / SELECTION_DPI,
                h: canvas.height * 72 / SELECTION_DPI
            };
            resolveBlob(blob);
            showStatus('Área copiada como imagen. Hacé clic en la página o presioná Ctrl+V para pegarla.', 7000, 'check-circle');
            showPasteHint();
        } catch (e) {
            rejectBlob(e);
            throw e;
        }
    });
}

/** Ctrl+V: pega la imagen del portapapeles (del sistema o la última Selección) sobre la página actual. */
function onPaste(e) {
    if (!hasDocument() || !state.pageMapper || isAnyDialogOpen() || isTextField(e.target)) return;
    const items = e.clipboardData ? Array.from(e.clipboardData.items || []) : [];
    const imageItem = items.find(it => it.kind === 'file' && it.type.startsWith('image/'));
    const file = imageItem ? imageItem.getAsFile() : null;
    if (!file && !imageClipboard) return;
    e.preventDefault();
    hidePasteHint();

    runTask(async () => {
        let img;
        if (file) {
            const bitmap = await createImageBitmap(file);
            const pxW = bitmap.width, pxH = bitmap.height;
            bitmap.close();
            let bytes = await readFileBytes(file);
            let type = detectImageType(bytes);
            if (!type) ({ bytes, type } = await decodeWithBrowser(file));
            // Si es la misma imagen copiada con Selección, se respeta su tamaño original en la página
            const own = imageClipboard && imageClipboard.pxW === pxW && imageClipboard.pxH === pxH;
            img = own
                ? { bytes, type, w: imageClipboard.w, h: imageClipboard.h }
                : { bytes, type, w: pxW * 0.75, h: pxH * 0.75 };
        } else {
            img = { bytes: imageClipboard.bytes, type: 'png', w: imageClipboard.w, h: imageClipboard.h };
        }
        openImageEditor(img);
    });
}

/** Centro de la parte visible de la página, en coordenadas de pantalla (zoom 1). */
function visiblePageCenter() {
    const c = ui.pageCanvas.getBoundingClientRect();
    const v = ui.scrollArea.getBoundingClientRect();
    const left = Math.max(c.left, v.left), right = Math.min(c.right, v.right);
    const top = Math.max(c.top, v.top), bottom = Math.min(c.bottom, v.bottom);
    const cx = right > left ? (left + right) / 2 : c.left + c.width / 2;
    const cy = bottom > top ? (top + bottom) / 2 : c.top + c.height / 2;
    return { x: (cx - c.left) / state.zoomFactor, y: (cy - c.top) / state.zoomFactor };
}

/**
 * Abre el editor de imagen. Si se indica `rect` (pantalla, zoom 1) la imagen aparece exactamente ahí
 * (reedición de una ya colocada); si no, se centra en `center`. `undoFrom` = estado previo a reabrirla.
 */
function openImageEditor({ bytes, type, w, h }, { center = null, rect = null, undoFrom = null } = {}) {
    const mapper = state.pageMapper;
    let x, y;
    if (rect) {
        ({ x0: x, y0: y } = rect);
        w = rect.x1 - rect.x0;
        h = rect.y1 - rect.y0;
    } else {
        // Si no entra en la página se achica manteniendo la proporción
        const fit = Math.min(1, (mapper.width * 0.9) / w, (mapper.height * 0.9) / h);
        w *= fit;
        h *= fit;
        const c = center || visiblePageCenter();
        x = Math.min(Math.max(0, c.x - w / 2), Math.max(0, mapper.width - w));
        y = Math.min(Math.max(0, c.y - h / 2), Math.max(0, mapper.height - h));
    }

    const el = document.createElement('div');
    el.className = 'image-editor';
    el.innerHTML = `
        <img alt="">
        <span class="img-handle nw" data-corner="nw"></span>
        <span class="img-handle ne" data-corner="ne"></span>
        <span class="img-handle sw" data-corner="sw"></span>
        <span class="img-handle se" data-corner="se"></span>
        <div class="text-toolbar">
            <span class="text-grip" title="Arrastra para mover la imagen">${icon("arrows-out-cardinal")}</span>
            <button type="button" class="img-ok" title="Aplicar (Enter)">${icon("check")}</button>
            <button type="button" class="img-del" title="Eliminar imagen (Supr)">${icon("trash")}</button>
        </div>
    `;
    const url = URL.createObjectURL(new Blob([bytes], { type: type === 'jpg' ? 'image/jpeg' : 'image/png' }));
    el.querySelector('img').src = url;
    ui.pageWrapper.appendChild(el);

    imageEditor = { el, url, bytes, type, x, y, w, h, ratio: h / w, page: state.currentPage, mapper, undoFrom };
    layoutImageEditor();

    el.querySelector('.img-ok').addEventListener('click', () => commitImageEditor());
    el.querySelector('.img-del').addEventListener('click', () => deleteImageEditor());
    el.addEventListener('pointerdown', onImageEditorPointerDown);

    showStatus('Arrastra la imagen para moverla y usa las esquinas para redimensionarla (Shift = libre). Enter o clic fuera para aplicar, Esc para cancelar, Supr para eliminar.', 0, 'image');
}

function layoutImageEditor() {
    const { el, x, y, w, h } = imageEditor;
    const z = state.zoomFactor;
    el.style.left = `${x * z}px`;
    el.style.top = `${y * z}px`;
    el.style.width = `${w * z}px`;
    el.style.height = `${h * z}px`;
    el.classList.toggle('toolbar-below', y * z < 40);
}

function onImageEditorPointerDown(e) {
    if (e.button !== 0 || !imageEditor) return;
    if (e.target.closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    const ed = imageEditor;
    const el = ed.el;
    const corner = e.target.dataset ? e.target.dataset.corner : undefined;
    const z = state.zoomFactor;
    const startX = e.clientX, startY = e.clientY;
    const start = { x: ed.x, y: ed.y, w: ed.w, h: ed.h };
    const pageW = ed.mapper.width, pageH = ed.mapper.height;
    const MIN = 8;
    el.classList.add('moving');
    el.setPointerCapture(e.pointerId);

    const onMove = ev => {
        const dx = (ev.clientX - startX) / z;
        const dy = (ev.clientY - startY) / z;
        if (!corner) {
            // Mover: la imagen puede salir parcialmente, pero no perderse fuera de la hoja
            ed.x = Math.min(pageW - MIN, Math.max(MIN - ed.w, start.x + dx));
            ed.y = Math.min(pageH - MIN, Math.max(MIN - ed.h, start.y + dy));
        } else {
            // Redimensionar desde una esquina; la esquina opuesta queda fija
            const west = corner.includes('w'), north = corner.includes('n');
            let w = Math.max(MIN, start.w + (west ? -dx : dx));
            let h = Math.max(MIN, start.h + (north ? -dy : dy));
            if (!ev.shiftKey) {
                // Mantener proporción: manda el eje que más se movió
                if (w / start.w > h / start.h) h = w * ed.ratio; else w = h / ed.ratio;
            }
            ed.w = w;
            ed.h = h;
            ed.x = west ? start.x + start.w - w : start.x;
            ed.y = north ? start.y + start.h - h : start.y;
        }
        layoutImageEditor();
    };
    const onUp = () => {
        el.classList.remove('moving');
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onUp);
        ed.ratio = ed.h / ed.w;
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
}

/* Burbuja que sigue al mouse después de copiar: un clic sobre la página pega la selección ahí. */

let pasteHint = null;
const lastMouse = { x: 0, y: 0 };

function showPasteHint() {
    hidePasteHint();
    const el = document.createElement('div');
    el.className = 'paste-hint';
    el.textContent = 'Hacé clic o Ctrl+V para pegar la selección';
    document.body.appendChild(el);
    pasteHint = el;
    positionPasteHint();
}

function hidePasteHint() {
    if (pasteHint) pasteHint.remove();
    pasteHint = null;
}

function positionPasteHint() {
    if (!pasteHint) return;
    const offX = 16, offY = 18;
    let x = lastMouse.x + offX;
    let y = lastMouse.y + offY;
    // Cerca de los bordes de la ventana la burbuja se ubica del otro lado del cursor
    if (x + pasteHint.offsetWidth > window.innerWidth - 4) x = lastMouse.x - offX - pasteHint.offsetWidth;
    if (y + pasteHint.offsetHeight > window.innerHeight - 4) y = lastMouse.y - offY - pasteHint.offsetHeight;
    pasteHint.style.left = `${Math.max(4, x)}px`;
    pasteHint.style.top = `${Math.max(4, y)}px`;
    pasteHint.classList.toggle('flip-x', x < lastMouse.x);
    pasteHint.classList.toggle('flip-y', y < lastMouse.y);
}

/** Clic con la burbuja activa: pega la última selección centrada en el punto clickeado. */
function pasteSelectionAt(screenPt) {
    hidePasteHint();
    if (!imageClipboard) return;
    const { bytes, w, h } = imageClipboard;
    runTask(async () => openImageEditor({ bytes, type: 'png', w, h }, { center: screenPt }));
}

function closeImageEditor() {
    const ed = imageEditor;
    imageEditor = null;
    if (ed) {
        ed.el.remove();
        URL.revokeObjectURL(ed.url);
    }
    return ed;
}

/** Coloca la imagen en el PDF en la posición y tamaño elegidos (queda reeditable con un clic). */
function commitImageEditor() {
    const ed = closeImageEditor();
    if (!ed) return;
    showStatus('');
    const { bytes, type, x, y, w, h, page, mapper, undoFrom } = ed;
    runTask(() => editDocument(
        doc => addImageStampAnnot(doc, doc.getPage(page), mapper, { bytes, type }, x, y, w, h),
        { undoFrom }
    ));
}

/** Esc: una imagen nueva se descarta; una ya colocada vuelve a como estaba. */
function cancelImageEditor() {
    const ed = closeImageEditor();
    if (!ed) return;
    if (ed.undoFrom) {
        showStatus('');
        runTask(async () => {
            state.pdfBytes = ed.undoFrom.bytes;
            await reloadViewer();
        });
    } else {
        showStatus('Imagen descartada.', 3000);
    }
}

/** 🗑 / Supr: elimina la imagen (si ya estaba colocada, queda registrado en el historial). */
function deleteImageEditor() {
    const ed = closeImageEditor();
    if (!ed) return;
    showStatus('Imagen eliminada.', 3000);
    if (ed.undoFrom) runTask(() => editDocument(() => {}, { undoFrom: ed.undoFrom }));
}

/* Reedición de imágenes ya colocadas: clic sobre ellas en modo Navegar o Selección. */

let imageStampRects = [];   // rectángulos PDF de las imágenes reeditables de la página visible

async function refreshImageStampRects(page) {
    imageStampRects = [];
    try {
        const annots = await page.getAnnotations();
        if (page.pageNumber - 1 !== state.currentPage) return;
        imageStampRects = annots
            .filter(a => a.subtype === 'Stamp' && a.rect)
            .map(a => ({ x0: a.rect[0], y0: a.rect[1], x1: a.rect[2], y1: a.rect[3] }));
    } catch (e) { /* sin anotaciones legibles */ }
}

function imageStampAt(pdfPt) {
    return imageStampRects.some(r => rectContains(r, pdfPt));
}

/** Gira una imagen `angle` grados en sentido horario (para páginas rotadas después de colocarla). */
async function rotateImageBytes(bytes, type, angle) {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: type === 'jpg' ? 'image/jpeg' : 'image/png' }));
    const swap = angle === 90 || angle === 270;
    const canvas = document.createElement('canvas');
    canvas.width = swap ? bitmap.height : bitmap.width;
    canvas.height = swap ? bitmap.width : bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(angle * Math.PI / 180);
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    bitmap.close();
    return canvasToPngBytes(canvas);
}

/** Saca de la página la imagen bajo el punto y la abre en el editor para moverla / redimensionarla. */
async function beginImageEditAt(screenPt) {
    const pdfPt = state.pageMapper.toPdf(screenPt.x, screenPt.y);
    const prev = { bytes: state.pdfBytes, page: state.currentPage };
    const doc = await loadLibDoc(state.pdfBytes);
    const found = takeImageStampAt(doc, doc.getPage(state.currentPage), pdfPt);
    if (!found) return false;

    state.pdfBytes = await doc.save();
    await reloadViewer();
    let { bytes, type } = found;
    const delta = (((state.pageMapper.rotate - found.rotate) % 360) + 360) % 360;
    if (delta) {
        bytes = await rotateImageBytes(bytes, type, delta);
        type = 'png';
    }
    const rect = state.pageMapper.rectToScreen(found.rect);
    openImageEditor({ bytes, type }, { rect, undoFrom: prev });
    return true;
}

/* ---------- Texto: palabras, selección y OCR ---------- */

/** Equivalente a page.get_text("words"): lista de {x0,y0,x1,y1,text} en coordenadas PDF. */
async function getPageWords(pageIndex) {
    if (wordsCache.has(pageIndex)) return wordsCache.get(pageIndex);
    const page = await state.pdfJsDoc.getPage(pageIndex + 1);
    const content = await page.getTextContent();
    const words = [];
    for (const [itemIndex, item] of content.items.entries()) {
        if (!item.str || !item.str.trim()) continue;
        const [a, b, c, d, e, f] = item.transform;
        const sx = Math.hypot(a, b) || 1;
        const fontH = Math.hypot(c, d) || item.height || sx;
        const dir = { x: a / sx, y: b / sx };
        const up = { x: c / fontH, y: d / fontH };
        const len = item.str.length;
        const re = /\S+/g;
        let m;
        while ((m = re.exec(item.str))) {
            const s0 = item.width * (m.index / len);
            const s1 = item.width * ((m.index + m[0].length) / len);
            const corners = [];
            for (const s of [s0, s1]) {
                for (const t of [-0.25 * fontH, 0.85 * fontH]) {
                    corners.push({ x: e + dir.x * s + up.x * t, y: f + dir.y * s + up.y * t });
                }
            }
            words.push({
                ...rectFromPoints(corners),
                text: m[0],
                // Datos para reconstruir el orden y los espacios reales del texto
                item: itemIndex,
                fontH,
                dir,
                along0: e * dir.x + f * dir.y + s0,
                along1: e * dir.x + f * dir.y + s1,
                across: e * up.x + f * up.y
            });
        }
    }
    wordsCache.set(pageIndex, words);
    return words;
}

async function getWordAtPoint(pdfPt) {
    if (!hasDocument()) return '';
    const words = await getPageWords(state.currentPage);
    const word = words.find(w => rectContains(w, pdfPt));
    return word ? word.text : '';
}

/** Une las líneas de texto: quita guiones de corte de palabra y descarta líneas vacías. */
function joinTextLines(lines) {
    let out = '';
    for (const raw of lines) {
        const line = raw.replace(/\s+/g, ' ').trim();
        if (!line) continue;
        if (!out) out = line;
        else if (/\p{L}-$/u.test(out) && /^\p{Ll}/u.test(line)) out = out.slice(0, -1) + line;
        else out += '\n' + line;
    }
    return out;
}

/**
 * Reconstruye el texto nativo según la posición de cada palabra: agrupa por línea, ordena de
 * izquierda a derecha y solo pone espacio cuando hay separación real (las partes de una misma
 * palabra que el PDF guarda por separado se unen sin espacio).
 */
/** Agrupa las palabras nativas por renglón (de arriba a abajo) y las ordena de izquierda a derecha. */
function groupWordsIntoLines(words) {
    const sorted = [...words].sort((a, b) => b.across - a.across || a.along0 - b.along0);
    const lines = [];
    for (const w of sorted) {
        const line = lines[lines.length - 1];
        if (line && Math.abs(line.across - w.across) < 0.5 * Math.min(line.fontH, w.fontH)) line.words.push(w);
        else lines.push({ across: w.across, fontH: w.fontH, words: [w] });
    }
    for (const line of lines) line.words.sort((a, b) => a.along0 - b.along0);
    return lines;
}

function buildTextFromWords(words) {
    const lines = groupWordsIntoLines(words);
    const texts = lines.map(line => {
        const ws = line.words;
        let text = ws[0].text;
        for (let i = 1; i < ws.length; i++) {
            const prev = ws[i - 1];
            const cur = ws[i];
            const gap = cur.along0 - prev.along1;
            // Palabras del mismo fragmento ya venían separadas por espacios en el PDF
            const needsSpace = cur.item === prev.item || gap > 0.15 * Math.min(prev.fontH, cur.fontH);
            text += (needsSpace ? ' ' : '') + cur.text;
        }
        return text;
    });
    return joinTextLines(texts);
}

/** Prepara el recorte para Tesseract: escala de grises, contraste, fondo claro y margen blanco. */
const OCR_PAD = 24;

function preprocessForOcr(source) {
    const pad = OCR_PAD;
    const canvas = document.createElement('canvas');
    canvas.width = source.width + pad * 2;
    canvas.height = source.height + pad * 2;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, pad, pad);

    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = img.data;
    const gray = new Uint8ClampedArray(px.length / 4);
    const hist = new Uint32Array(256);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
        const alpha = px[i + 3] / 255;
        const g = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) * alpha + 255 * (1 - alpha);
        gray[j] = g;
        hist[gray[j]]++;
    }
    // Estiramiento de contraste ignorando el 1% de valores extremos
    const total = gray.length;
    let lo = 0, hi = 255, acc = 0;
    while (lo < 255 && (acc += hist[lo]) < total * 0.01) lo++;
    acc = 0;
    while (hi > 0 && (acc += hist[hi]) < total * 0.01) hi--;
    const range = Math.max(1, hi - lo);
    let sum = 0;
    for (let j = 0; j < total; j++) sum += gray[j];
    const invert = sum / total < 128; // texto claro sobre fondo oscuro
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
        let v = ((gray[j] - lo) * 255) / range;
        if (invert) v = 255 - v;
        px[i] = px[i + 1] = px[i + 2] = v;
        px[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
}

/** Limpia el texto devuelto por el OCR (espacios duplicados, espacios antes de signos, cortes de palabra). */
function cleanOcrText(text) {
    const lines = (text || '').split(/\r?\n/).map(l => l
        .replace(/\s+([.,;:!?%)\]}])/g, '$1')
        .replace(/([¿¡(\[{])\s+/g, '$1'));
    return joinTextLines(lines);
}

let ocrWorkerPromise = null;

function getOcrWorker() {
    if (!ocrWorkerPromise) {
        ocrWorkerPromise = (async () => {
            await loadScript(TESSERACT_URL);
            return Tesseract.createWorker('spa+eng', Tesseract.OEM.LSTM_ONLY);
        })().catch(e => {
            ocrWorkerPromise = null;
            throw e;
        });
    }
    return ocrWorkerPromise;
}

async function ocrCanvas(canvas) {
    const worker = await getOcrWorker();
    const image = preprocessForOcr(canvas);
    const run = async psm => {
        await worker.setParameters({ tessedit_pageseg_mode: psm, user_defined_dpi: '300' });
        const { data } = await worker.recognize(image);
        return { text: cleanOcrText(data.text), confidence: data.confidence || 0 };
    };
    // Bloque uniforme de texto; si resulta una sola línea se prueba también el modo "línea única"
    let best = await run(Tesseract.PSM.SINGLE_BLOCK);
    if (!best.text.includes('\n')) {
        const single = await run(Tesseract.PSM.SINGLE_LINE);
        if (single.text && single.confidence > best.confidence) best = single;
    }
    return best.text;
}

/**
 * Posiciones de los renglones leídos por OCR en un recorte de la página (en píxeles del recorte,
 * sin el margen agregado): [{ baseline: {x0,y0,x1,y1}, top, words: [{x0,x1}] }].
 */
async function ocrLinesInCanvas(canvas) {
    const worker = await getOcrWorker();
    await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK, user_defined_dpi: '300' });
    const { data } = await worker.recognize(preprocessForOcr(canvas), {}, { text: true, blocks: true });
    const lines = [];
    for (const block of data.blocks || []) {
        for (const para of block.paragraphs || []) {
            for (const line of para.lines || []) {
                // Se descartan manchas o ruido que el OCR confunde con letras
                const words = (line.words || []).filter(w => w.text.trim() && w.confidence >= 20 && /[\p{L}\p{N}]/u.test(w.text));
                if (!words.length || !line.baseline) continue;
                const b = line.baseline;
                lines.push({
                    baseline: { x0: b.x0 - OCR_PAD, y0: b.y0 - OCR_PAD, x1: b.x1 - OCR_PAD, y1: b.y1 - OCR_PAD },
                    top: Math.min(...words.map(w => w.bbox.y0)) - OCR_PAD,
                    words: words.map(w => ({ x0: w.bbox.x0 - OCR_PAD, x1: w.bbox.x1 - OCR_PAD }))
                });
            }
        }
    }
    return lines;
}

/** Tachado sobre el texto nativo: una línea por renglón a la altura media de las minúsculas. */
function strikeSegmentsFromWords(words, underline = false) {
    return groupWordsIntoLines(words).map(line => {
        const first = line.words[0];
        const last = line.words[line.words.length - 1];
        const { dir } = first;
        const up = { x: -dir.y, y: dir.x };
        const across = line.across + (underline ? -0.14 : 0.28) * line.fontH;
        const at = along => ({ x: dir.x * along + up.x * across, y: dir.y * along + up.y * across });
        return { p1: at(first.along0), p2: at(last.along1), width: Math.max(0.5, 0.07 * line.fontH) };
    });
}

/** Tachado sobre texto escaneado: se ubica cada renglón con OCR y se traza siguiendo su línea base. */
async function strikeSegmentsFromOcr(screenRect, underline = false) {
    const dpi = 300;
    const scale = dpi / 72;
    const canvas = await renderPageRegion(state.currentPage, screenRect, dpi);
    if (!canvas) return [];
    const lines = await ocrLinesInCanvas(canvas);
    // Origen del recorte en coordenadas de pantalla (igual que en renderPageRegion)
    const ox = Math.max(0, Math.floor(screenRect.x0 * scale)) / scale;
    const oy = Math.max(0, Math.floor(screenRect.y0 * scale)) / scale;
    const mapper = state.pageMapper;
    return lines.map(line => {
        const b = line.baseline;
        const slope = b.x1 !== b.x0 ? (b.y1 - b.y0) / (b.x1 - b.x0) : 0;
        const baseAt = x => b.y0 + slope * (x - b.x0);
        const x0 = Math.min(...line.words.map(w => w.x0));
        const x1 = Math.max(...line.words.map(w => w.x1));
        // Altura de las mayúsculas del renglón; el tachado va a la mitad de las minúsculas
        const capH = Math.max(4, baseAt((x0 + x1) / 2) - line.top);
        const offset = (underline ? -0.15 : 0.35) * capH;
        const toPdf = (x, y) => mapper.toPdf(ox + x / scale, oy + y / scale);
        return {
            p1: toPdf(x0, baseAt(x0) - offset),
            p2: toPdf(x1, baseAt(x1) - offset),
            width: Math.max(0.5, (0.1 * capH) / scale)
        };
    });
}

async function applyStrikethrough(pdfRect, screenRect, underline = false) {
    if (!hasDocument()) return;
    const words = await getPageWords(state.currentPage);
    const selected = words.filter(w => rectIntersects(pdfRect, w));
    let segments;
    if (selected.length) {
        segments = strikeSegmentsFromWords(selected, underline);
    } else {
        try {
            showStatus(`Buscando texto con OCR para ${underline ? 'subrayar' : 'tachar'}...`, 0, 'magnifying-glass');
            segments = await strikeSegmentsFromOcr(screenRect, underline);
        } catch (e) {
            console.warn('OCR no disponible:', e);
            segments = [];
        }
        showStatus('');
    }
    if (!segments.length) {
        showStatus('No se detectó texto en esa área.', 5000, 'warning');
        return;
    }
    await editDocument(doc => drawStrikeLines(doc, doc.getPage(state.currentPage), segments, state.brushColor));
}

async function extractTextFromRect(pdfRect, screenRect) {
    if (!hasDocument()) return '';
    const words = await getPageWords(state.currentPage);
    const selected = words.filter(w => rectIntersects(pdfRect, w));
    const nativeText = selected.length ? buildTextFromWords(selected) : '';
    if (nativeText) return nativeText;

    // Sin texto nativo: se intenta OCR (español + inglés) como en pytesseract
    try {
        showStatus('Aplicando OCR (spa+eng) a la selección...', 0, 'magnifying-glass');
        const canvas = await renderPageRegion(state.currentPage, screenRect, 300);
        if (!canvas) return '';
        return await ocrCanvas(canvas);
    } catch (e) {
        console.warn('OCR no disponible:', e);
        return '';
    }
}

/** Equivalente a start_drag_text_operation(): el texto queda disponible para arrastrarlo a otra aplicación. */
let dragChip = null;
let dragChipTimer = null;

function removeDragChip() {
    clearTimeout(dragChipTimer);
    if (dragChip) dragChip.remove();
    dragChip = null;
}

function startDragTextOperation(text, clientX, clientY) {
    removeDragChip();
    const chip = document.createElement('div');
    chip.className = 'drag-chip';
    chip.draggable = true;
    chip.title = 'Arrastra este texto a otra aplicación';
    chip.innerHTML = icon('dots-six-vertical');
    chip.append(` ${text.length > 60 ? text.slice(0, 57) + '...' : text}`);
    chip.style.left = `${clientX + 12}px`;
    chip.style.top = `${clientY + 12}px`;
    chip.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', text);
        e.dataTransfer.effectAllowed = 'copy';
    });
    chip.addEventListener('dragend', removeDragChip);
    document.body.appendChild(chip);
    dragChip = chip;
    dragChipTimer = setTimeout(removeDragChip, 8000);
}

/* ---------- Interacción con el lienzo (InteractivePDFLabel) ---------- */

const interaction = {
    drawing: false,
    currentStroke: [],        // puntos en coordenadas de pantalla (zoom 1)
    interactiveDrag: false,
    startPoint: null,         // píxeles CSS relativos al lienzo
    endPoint: null
};

function eventToCanvasPoint(e) {
    const r = ui.pageCanvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function canvasToScreen(p) {
    return { x: p.x / state.zoomFactor, y: p.y / state.zoomFactor };
}

function screenToPdfCoords(p) {
    const s = canvasToScreen(p);
    return state.pageMapper.toPdf(s.x, s.y);
}

function clearOverlay() {
    const ctx = ui.overlay.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ui.overlay.width, ui.overlay.height);
}

function rgbaFromBrush(alpha = 1) {
    const [r, g, b] = state.brushColor.map(v => Math.round(v * 255));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** paintEvent(): vista previa mientras se arrastra. */
function paintOverlay() {
    clearOverlay();
    const ctx = ui.overlay.getContext('2d');
    const dpr = ui.overlay.width / parseFloat(ui.overlay.style.width || ui.overlay.width);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const mode = state.currentMode;

    if (interaction.drawing && mode === 'draw' && interaction.currentStroke.length > 1) {
        ctx.strokeStyle = rgbaFromBrush();
        ctx.lineWidth = state.brushWidth * state.zoomFactor;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        interaction.currentStroke.forEach((p, i) => {
            const x = p.x * state.zoomFactor, y = p.y * state.zoomFactor;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
        return;
    }
    if (!interaction.interactiveDrag) return;

    const s = interaction.startPoint;
    const e = interaction.endPoint;
    const x = Math.min(s.x, e.x), y = Math.min(s.y, e.y);
    const w = Math.abs(e.x - s.x), h = Math.abs(e.y - s.y);
    ctx.setLineDash([]);

    if (mode === 'highlight') {
        ctx.fillStyle = rgbaFromBrush(60 / 255);
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = rgbaFromBrush();
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 2]);
        ctx.strokeRect(x, y, w, h);
    } else if (mode === 'strike' || mode === 'underline') {
        ctx.strokeStyle = rgbaFromBrush();
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 2]);
        ctx.strokeRect(x, y, w, h);
    } else if (mode === 'copy_text') {
        ctx.fillStyle = 'rgba(0, 120, 215, ' + (70 / 255) + ')';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgb(0, 100, 200)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);
    } else if (mode === 'rect') {
        ctx.strokeStyle = rgbaFromBrush();
        ctx.lineWidth = state.brushWidth;
        ctx.strokeRect(x, y, w, h);
    } else if (mode === 'arrow' || mode === 'line') {
        ctx.strokeStyle = rgbaFromBrush();
        ctx.lineWidth = state.brushWidth;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(e.x, e.y);
        ctx.stroke();
    } else if (mode === 'crop') {
        ctx.fillStyle = 'rgba(255, 0, 0, ' + (30 / 255) + ')';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgb(255, 0, 0)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(x, y, w, h);
    } else if (mode === 'erase_area') {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgb(120, 120, 120)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(x, y, w, h);
    } else if (mode === 'select' || mode === 'qr') {
        ctx.fillStyle = 'rgba(0, 120, 215, ' + (30 / 255) + ')';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgb(0, 120, 215)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(x, y, w, h);
    }
}

function onPageMouseDown(e) {
    if (!hasDocument() || !state.pageMapper) return;
    if (e.button !== 0 || e.detail === 2) return; // el segundo clic de un doble clic lo maneja dblclick
    e.preventDefault();
    const mode = state.currentMode;
    const canvasPt = eventToCanvasPoint(e);
    const screenPt = canvasToScreen(canvasPt);

    if (pasteHint) {
        pasteSelectionAt(screenPt);
        return;
    }
    // Clic sobre una imagen ya colocada (modo Navegar): se reabre para moverla / redimensionarla
    if (mode === 'navigate' && imageStampAt(screenToPdfCoords(canvasPt))) {
        runTask(() => beginImageEditAt(screenPt));
        return;
    }

    if (mode === 'note') {
        createNoteAt(screenPt);
    } else if (mode === 'text') {
        // El clic que cerró un editor abierto solo lo aplica; no crea otro cuadro
        if (textEditorClosedByClick) {
            textEditorClosedByClick = false;
            return;
        }
        runTask(() => beginTextAt(screenPt));
    } else if (mode === 'draw') {
        interaction.drawing = true;
        interaction.currentStroke = [screenPt];
    } else if (DRAG_MODES.includes(mode)) {
        // Sin foco en campos de texto, para que el Ctrl+V posterior llegue a la página
        if (mode === 'select' && isTextField(document.activeElement)) document.activeElement.blur();
        interaction.interactiveDrag = true;
        interaction.startPoint = canvasPt;
        interaction.endPoint = canvasPt;
        paintOverlay();
    } else if (mode === 'erase') {
        const pdfPt = screenToPdfCoords(canvasPt);
        runTask(() => deleteAnnotationAtPoint(pdfPt));
    }
}

function onPageMouseMove(e) {
    lastMouse.x = e.clientX;
    lastMouse.y = e.clientY;
    positionPasteHint();
    const mode = state.currentMode;
    // Cursor de mano sobre las imágenes que se pueden reubicar
    if (e.target === ui.overlay && state.pageMapper && !interaction.interactiveDrag && !interaction.drawing) {
        const over = !pasteHint && (mode === 'navigate' || mode === 'select') &&
            imageStampAt(screenToPdfCoords(eventToCanvasPoint(e)));
        ui.overlay.style.cursor = over ? 'pointer' : '';
    }
    if (interaction.drawing && mode === 'draw') {
        interaction.currentStroke.push(canvasToScreen(eventToCanvasPoint(e)));
        paintOverlay();
    } else if (interaction.interactiveDrag && DRAG_MODES.includes(mode)) {
        interaction.endPoint = eventToCanvasPoint(e);
        paintOverlay();
    }
}

function onPageMouseUp(e) {
    if (e.button !== 0) return;
    const mode = state.currentMode;

    if (interaction.drawing && mode === 'draw') {
        interaction.drawing = false;
        const stroke = interaction.currentStroke;
        interaction.currentStroke = [];
        if (stroke.length > 1) {
            const mapper = state.pageMapper;
            const points = stroke.map(p => mapper.toPdf(p.x, p.y));
            runTask(async () => {
                await applyDrawing(points);
                clearOverlay();
            });
        } else {
            clearOverlay();
        }
        return;
    }

    if (!(interaction.interactiveDrag && DRAG_MODES.includes(mode))) return;
    interaction.interactiveDrag = false;
    interaction.endPoint = eventToCanvasPoint(e);
    clearOverlay();

    const start = interaction.startPoint;
    const end = interaction.endPoint;
    const s1 = canvasToScreen(start);
    const s2 = canvasToScreen(end);
    const screenRect = { x0: Math.min(s1.x, s2.x), y0: Math.min(s1.y, s2.y), x1: Math.max(s1.x, s2.x), y1: Math.max(s1.y, s2.y) };
    const pdfRect = state.pageMapper.rectToPdf(screenRect.x0, screenRect.y0, screenRect.x1, screenRect.y1);
    const rw = pdfRect.x1 - pdfRect.x0;
    const rh = pdfRect.y1 - pdfRect.y0;

    if (mode === 'highlight') {
        if (rw > 2 && rh > 2) runTask(() => applyAreaHighlight(pdfRect));
    } else if (mode === 'rect') {
        if (rw > 2 && rh > 2) runTask(() => addRectAnnotation(pdfRect));
    } else if (mode === 'strike' || mode === 'underline') {
        if (rw > 2 && rh > 2) runTask(() => applyStrikethrough(pdfRect, screenRect, mode === 'underline'));
    } else if (mode === 'arrow' || mode === 'line') {
        if (Math.abs(start.x - end.x) > 3 || Math.abs(start.y - end.y) > 3) {
            const p1 = screenToPdfCoords(start);
            const p2 = screenToPdfCoords(end);
            runTask(() => mode === 'line' ? addLineAnnotation(p1, p2) : addArrowAnnotation(p1, p2));
        }
    } else if (mode === 'crop') {
        if (rw > 10 && rh > 10) runTask(() => applyCropAsNewPage(screenRect));
    } else if (mode === 'erase_area') {
        if (rw > 2 && rh > 2) runTask(() => applyEraseArea(pdfRect));
    } else if (mode === 'qr') {
        if (rw > 5 && rh > 5) runTask(() => validateQrInRect(screenRect));
    } else if (mode === 'select') {
        if (rw > 3 && rh > 3) copySelectionAsImage(screenRect);
        else if (imageStampAt(screenToPdfCoords(end))) runTask(() => beginImageEditAt(canvasToScreen(end)));
    } else if (mode === 'copy_text') {
        if (rw > 1 && rh > 1) {
            const { clientX, clientY } = e;
            runTask(async () => {
                const extractedText = await extractTextFromRect(pdfRect, screenRect);
                if (extractedText) {
                    await copyToClipboard(extractedText);
                    showStatus(`COPIADO AL PORTAPAPELES: "${extractedText}"`, 7000, 'check-circle');
                    startDragTextOperation(extractedText, clientX, clientY);
                } else {
                    showStatus('No se detectó texto en esa área.', 5000, 'warning');
                }
            });
        }
    }
}

function onPageDoubleClick(e) {
    if (!hasDocument() || !state.pageMapper || e.button !== 0) return;
    const pdfPt = screenToPdfCoords(eventToCanvasPoint(e));
    const { clientX, clientY } = e;
    if (state.currentMode === 'highlight') {
        runTask(async () => {
            const words = await getPageWords(state.currentPage);
            const word = words.find(w => rectContains(w, pdfPt));
            if (!word) {
                showStatus('No se detectó una palabra bajo el cursor.', 4000, 'warning');
                return;
            }
            await editDocument(doc => addHighlightAnnot(doc, doc.getPage(state.currentPage), [word], state.brushColor));
        });
        return;
    }
    if (state.currentMode === 'underline' || state.currentMode === 'strike') {
        runTask(async () => {
            const words = await getPageWords(state.currentPage);
            const word = words.find(w => rectContains(w, pdfPt));
            if (!word) {
                showStatus('No se detectó una palabra bajo el cursor.', 4000, 'warning');
                return;
            }
            const segments = strikeSegmentsFromWords([word], state.currentMode === 'underline');
            await editDocument(doc => drawStrikeLines(doc, doc.getPage(state.currentPage), segments, state.brushColor));
        });
        return;
    }
    runTask(async () => {
        const wordText = await getWordAtPoint(pdfPt);
        if (wordText) {
            await copyToClipboard(wordText);
            showStatus(`Palabra copiada al doble clic: "${wordText}"`, 6000, 'check-circle');
            startDragTextOperation(wordText, clientX, clientY);
        } else {
            showStatus('No se detectó una palabra bajo el cursor.', 4000, 'warning');
        }
    });
}

/* ---------- Conexión de eventos (init_ui / setup_shortcuts) ---------- */

function initUi() {
    initTextFormatBar();
    initSearch();
    initNotes();
    ui.btnOpen.addEventListener('click', openFileOrImage);
    ui.btnSave.addEventListener('click', () => runTask(savePdf));
    ui.btnSaveAs.addEventListener('click', () => runTask(savePdfAs));
    ui.btnPrint.addEventListener('click', () => runTask(printPdf));
    ui.btnExportImg.addEventListener('click', () => runTask(exportToImages));
    ui.btnExportPdf.addEventListener('click', () => runTask(savePdf));
    ui.btnUndo.addEventListener('click', () => runTask(undoAction));
    ui.btnRedo.addEventListener('click', () => runTask(redoAction));
    ui.btnGridView.addEventListener('click', () => runTask(openGridView));
    ui.btnQrValidate.addEventListener('click', toggleQrTool);
    ui.btnMerge.addEventListener('click', mergePdf);
    ui.btnSplit.addEventListener('click', () => runTask(extractPages));
    ui.btnSignature.addEventListener('click', () => runTask(configureStamp));
    ui.btnInsertImg.addEventListener('click', insertImageAsPage);
    ui.btnRotateLeft.addEventListener('click', () => runTask(() => rotatePage(-90)));
    ui.btnRotateRight.addEventListener('click', () => runTask(() => rotatePage(90)));
    ui.btnDeletePage.addEventListener('click', () => runTask(deleteCurrentPage));
    ui.btnBlankPage.addEventListener('click', () => runTask(insertBlankPage));
    ui.btnPrev.addEventListener('click', prevPage);
    ui.btnNext.addEventListener('click', nextPage);
    ui.btnZoomOut.addEventListener('click', zoomOut);
    ui.btnZoomIn.addEventListener('click', zoomIn);
    ui.btnTheme.addEventListener('click', toggleTheme);
    toggleTheme(); // arranca en modo oscuro

    ui.spinPage.addEventListener('input', () => {
        const v = parseInt(ui.spinPage.value, 10);
        if (!Number.isNaN(v) && v >= 1 && v <= state.totalPages && v - 1 !== state.currentPage) goToPage(v);
    });
    ui.spinPage.addEventListener('change', () => { ui.spinPage.value = String(state.currentPage + 1); });

    ui.fileOpen.addEventListener('change', () => {
        const files = Array.from(ui.fileOpen.files);
        if (files.length) runTask(() => openSelectedFiles(files));
    });
    ui.fileImages.addEventListener('change', () => {
        const files = Array.from(ui.fileImages.files);
        if (files.length) runTask(() => loadOrMergeDroppedFiles(files));
    });
    ui.fileMerge.addEventListener('change', () => {
        const files = Array.from(ui.fileMerge.files);
        if (files.length) runTask(() => loadOrMergeDroppedFiles([files[0]]));
    });

    document.querySelectorAll('input[name="mode"]').forEach(radio => {
        radio.addEventListener('change', () => { if (radio.checked) setMode(radio.value); });
    });

    ui.btnColor.addEventListener('click', chooseColor);
    ui.colorInput.addEventListener('change', () => {
        const hex = ui.colorInput.value;
        setBrushColor([1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255));
        const settings = toolSettings[state.currentMode];
        if (settings) settings.color = state.brushColor.slice();
    });

    ui.spinWidth.addEventListener('input', () => {
        const v = parseInt(ui.spinWidth.value, 10);
        if (!Number.isNaN(v) && v >= 1 && v <= 40) {
            changeBrushWidth(v);
            const settings = toolSettings[state.currentMode];
            if (settings && settings.width !== undefined) settings.width = v;
        }
    });
    ui.spinWidth.addEventListener('change', () => { ui.spinWidth.value = String(state.brushWidth); });
    changeBrushWidth(parseInt(ui.spinWidth.value, 10)); // spin_width.setValue(14)

    // Lienzo interactivo
    ui.overlay.addEventListener('mousedown', onPageMouseDown);
    ui.overlay.addEventListener('dblclick', onPageDoubleClick);
    window.addEventListener('mousemove', onPageMouseMove);
    window.addEventListener('mouseup', onPageMouseUp);
    document.addEventListener('mousedown', e => { if (dragChip && e.target !== dragChip) removeDragChip(); }, true);
    // Clic fuera del editor de texto: se aplica el texto
    document.addEventListener('mousedown', e => {
        textEditorClosedByClick = false;
        // La barra de formato de la barra superior edita el cuadro abierto: no lo cierra
        if (!textEditor || textEditor.el.contains(e.target) || ui.textFormatBar.contains(e.target) || isAnyDialogOpen()) return;
        textEditorClosedByClick = e.target === ui.overlay;
        commitTextEditor();
    }, true);
    // Clic fuera de la imagen pegada: se aplica en la página
    document.addEventListener('mousedown', e => {
        if (!imageEditor || imageEditor.el.contains(e.target) || isAnyDialogOpen()) return;
        commitImageEditor();
    }, true);
    // Clic fuera de la página con la burbuja activa: se cancela el pegado por clic
    document.addEventListener('mousedown', e => {
        if (pasteHint && e.target !== ui.overlay) hidePasteHint();
    }, true);
    // Pegar imagen (Ctrl+V)
    document.addEventListener('paste', onPaste);

    // La página actual cambia sola según la página que ocupa el centro de la vista
    let scrollTick = false;
    ui.scrollArea.addEventListener('scroll', () => {
        if (scrollTick) return;
        scrollTick = true;
        requestAnimationFrame(() => {
            scrollTick = false;
            if (!hasDocument() || interaction.drawing || interaction.interactiveDrag) return;
            const slots = ui.scrollArea.querySelectorAll('.page-slot');
            if (slots.length < 2) return;
            const v = ui.scrollArea.getBoundingClientRect();
            const mid = v.top + v.height / 2;
            for (let i = 0; i < slots.length; i++) {
                const r = slots[i].getBoundingClientRect();
                if (mid >= r.top - 10 && mid <= r.bottom + 10) {
                    if (i !== state.currentPage) {
                        lastScrolledPage = i;
                        state.currentPage = i;
                        renderCurrentPage();
                    }
                    break;
                }
            }
        });
    }, { passive: true });

    // Zoom con Ctrl + Rueda
    ui.scrollArea.addEventListener('wheel', e => {
        if (e.ctrlKey && hasDocument()) {
            e.preventDefault();
            if (e.deltaY < 0) zoomIn();
            else if (e.deltaY > 0) zoomOut();
        }
    }, { passive: false });

    // Arrastrar y soltar archivos en la ventana
    window.addEventListener('dragover', e => {
        if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        }
    });
    window.addEventListener('drop', e => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        if (isAnyDialogOpen()) return;
        const validFiles = filterValidFiles(e.dataTransfer.files);
        if (validFiles.length) runTask(() => loadOrMergeDroppedFiles(validFiles));
    });

    // Cambios sin guardar al cerrar (closeEvent)
    window.addEventListener('beforeunload', e => {
        if (state.isModified && hasDocument()) {
            e.preventDefault();
            e.returnValue = 'Tienes modificaciones sin guardar en el documento.';
        }
    });

    setupShortcuts();
}

/* ---------- Notas flotantes (post-it) ---------- */

const NOTE_COLORS = [
    ['Amarillo', [1, 0.9, 0.4]],
    ['Azul', [0.55, 0.8, 1]],
    ['Verde', [0.6, 0.9, 0.6]],
    ['Rosa', [1, 0.65, 0.8]],
    ['Naranja', [1, 0.75, 0.45]],
    ['Violeta', [0.8, 0.7, 1]],
];
const noteUi = { color: NOTE_COLORS[0][1].slice(), open: new Set(), token: 0 };

const noteRgbCss = c => `rgb(${c.map(v => Math.round(v * 255)).join(',')})`;

// Mismo dibujo que el ícono guardado en el PDF (viewBox 24x24, eje Y hacia abajo)
const NOTE_BUBBLE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="2" y="3" width="20" height="13" fill="var(--pn-color)" stroke="#404040" stroke-width="1"/>
    <path d="M6 16 L6 21 L12 16 Z" fill="var(--pn-color)" stroke="#404040" stroke-width="1" stroke-linejoin="miter"/>
    <path d="M5 7H19M5 10H19M5 13H14" stroke="#404040" stroke-width="1" fill="none"/>
</svg>`;

function notesLayer() {
    let layer = document.getElementById('notes-layer');
    if (!layer) {
        layer = document.createElement('div');
        layer.id = 'notes-layer';
    }
    if (layer.parentElement !== ui.pageWrapper) ui.pageWrapper.appendChild(layer);
    return layer;
}

/** Dibuja las notas de la página actual (anotaciones Text leídas con pdf.js). */
async function renderNotes() {
    const token = ++noteUi.token;
    const layer = notesLayer();
    if (!state.pdfJsDoc || !state.pageMapper) { layer.replaceChildren(); return; }
    let annots;
    try {
        const page = await state.pdfJsDoc.getPage(state.currentPage + 1);
        annots = await page.getAnnotations();
    } catch (e) {
        return;
    }
    if (token !== noteUi.token) return;
    layer.replaceChildren();
    for (const a of annots) {
        if (a.subtype !== 'Text') continue;
        const b = state.pageMapper.rectToScreen({ x0: a.rect[0], y0: a.rect[1], x1: a.rect[2], y1: a.rect[3] });
        const color = a.color && a.color.length === 3 ? Array.from(a.color, v => v / 255) : NOTE_COLORS[0][1].slice();
        const text = (a.contentsObj && a.contentsObj.str) || a.contents || '';
        layer.appendChild(buildNoteEl({ id: a.id, x: b.x0, y: b.y0, color, text, pinned: ((a.titleObj && a.titleObj.str) || a.title) === NOTE_PINNED_TITLE }));
    }
}

function buildNoteEl(n) {
    const z = state.zoomFactor;
    const el = document.createElement('div');
    el.className = 'pn';
    el.dataset.id = n.id;
    el._note = n;
    el.style.setProperty('--pn-color', noteRgbCss(n.color));
    el.style.setProperty('--pn-size', `${NOTE_SIZE * z}px`);
    el.style.left = `${n.x * z}px`;
    el.style.top = `${n.y * z}px`;
    el.innerHTML = `
        <button type="button" class="pn-bubble" title="Nota: clic para abrir, arrastra para mover">${NOTE_BUBBLE_SVG}</button>
        <div class="pn-box">
            <div class="pn-head" title="Arrastra para mover la nota">
                <span class="pn-dots">${NOTE_COLORS.map(([name, c], i) =>
                    `<button type="button" class="pn-dot" data-i="${i}" title="${name}" style="background:${noteRgbCss(c)}"></button>`).join('')}</span>
                <button type="button" class="pn-btn pn-pin" title="Mantener visible: la nota no se minimiza y se muestra abierta al abrir el PDF">${icon('push-pin')}</button>
                <button type="button" class="pn-btn pn-min" title="Minimizar">${icon('minus')}</button>
                <button type="button" class="pn-btn pn-del" title="Eliminar nota">${icon('trash')}</button>
            </div>
            <textarea class="pn-text" placeholder="Escribe tu nota…" spellcheck="false"></textarea>
        </div>`;
    const bubble = el.querySelector('.pn-bubble');
    const head = el.querySelector('.pn-head');
    const area = el.querySelector('.pn-text');
    area.value = n.text;
    el.classList.toggle('open', n.pinned || noteUi.open.has(n.id));
    el.classList.toggle('pinned', !!n.pinned);

    // Al pasar el cursor sobre el globo se muestra la nota; al salir se oculta (salvo que esté abierta)
    let peekTimer = null;
    el.addEventListener('pointerenter', () => {
        clearTimeout(peekTimer);
        peekTimer = setTimeout(() => el.classList.add('peek'), 120);
    });
    el.addEventListener('pointerleave', () => {
        clearTimeout(peekTimer);
        peekTimer = setTimeout(() => {
            if (document.activeElement !== area) el.classList.remove('peek');
        }, 300);
    });
    area.addEventListener('blur', () => {
        if (!el.matches(':hover')) el.classList.remove('peek');
    });

    // El texto se guarda al salir del campo
    area.addEventListener('change', () => commitNoteEdit(el, { text: area.value }));

    const openNote = () => {
        noteUi.open.add(n.id);
        el.classList.add('open');
        area.focus();
    };
    const minimizeNote = () => {
        noteUi.open.delete(n.id);
        el.classList.remove('open', 'peek');
        if (document.activeElement === area) area.blur();
    };

    startNoteDragOn(bubble, el, openNote);
    startNoteDragOn(head, el, null);

    // Botones de la cabecera: actúan al presionar (sin quitar el foco) para que no se pierda el texto escrito
    head.querySelectorAll('button').forEach(btn => btn.addEventListener('pointerdown', e => e.stopPropagation()));
    head.querySelector('.pn-pin').addEventListener('click', () => {
        const pinned = !el._note.pinned;
        el._note.pinned = pinned;
        el.classList.toggle('pinned', pinned);
        if (pinned) { noteUi.open.add(n.id); el.classList.add('open'); }
        commitNoteEdit(el, { pinned });
    });
    head.querySelector('.pn-min').addEventListener('click', () => {
        if (el._note.pinned) return;
        if (area.value !== el._note.text) commitNoteEdit(el, { text: area.value });
        minimizeNote();
    });
    head.querySelector('.pn-del').addEventListener('click', () => {
        noteUi.open.delete(n.id);
        el.remove();
        runTask(() => editDocument(doc => deleteNoteAnnot(doc, doc.getPage(el._page), n.id), { silent: true }));
        runTask(async () => { await renderCurrentPage(); });
    });
    head.querySelectorAll('.pn-dot').forEach(dot => dot.addEventListener('click', () => {
        const color = NOTE_COLORS[parseInt(dot.dataset.i, 10)][1].slice();
        el.style.setProperty('--pn-color', noteRgbCss(color));
        commitNoteEdit(el, { color }, true);
    }));

    el._page = state.currentPage;
    return el;
}

/** Guarda un cambio de una nota en el PDF sin recargar la vista. `redraw`: vuelve a dibujar la página (quita el ícono viejo). */
function commitNoteEdit(el, patch, redraw = false) {
    const note = el._note;
    const mapper = state.pageMapper;
    if (patch.pos) { note.x = patch.pos.x; note.y = patch.pos.y; }
    if (patch.color) note.color = patch.color;
    if (patch.text !== undefined) note.text = patch.text;
    runTask(async () => {
        const ok = await editDocument(doc => updateNoteAnnot(doc, mapper, note.id, patch), { silent: true });
        if (ok && redraw) await renderCurrentPage();
    });
}

/** Arrastrar el globo o la cabecera mueve la nota; un clic sin movimiento ejecuta `onClick`. */
function startNoteDragOn(handle, el, onClick) {
    handle.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const z = state.zoomFactor;
        const startX = e.clientX, startY = e.clientY;
        const left0 = parseFloat(el.style.left), top0 = parseFloat(el.style.top);
        const maxX = parseFloat(ui.pageCanvas.style.width) - NOTE_SIZE * z;
        const maxY = parseFloat(ui.pageCanvas.style.height) - NOTE_SIZE * z;
        let moved = false;
        handle.setPointerCapture(e.pointerId);

        const onMove = ev => {
            const dx = ev.clientX - startX, dy = ev.clientY - startY;
            if (!moved && Math.hypot(dx, dy) < 4) return;
            moved = true;
            el.classList.add('dragging');
            el.style.left = `${Math.min(Math.max(0, left0 + dx), maxX)}px`;
            el.style.top = `${Math.min(Math.max(0, top0 + dy), maxY)}px`;
        };
        const onUp = () => {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.removeEventListener('pointercancel', onUp);
            el.classList.remove('dragging');
            if (moved) {
                const pos = { x: parseFloat(el.style.left) / z, y: parseFloat(el.style.top) / z };
                commitNoteEdit(el, { pos }, true);
            } else if (onClick) {
                onClick();
            }
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
    });
}

/** Modo Nota: un clic en la página crea una nota con el color elegido en la paleta. */
function createNoteAt(screenPt) {
    const mapper = state.pageMapper;
    const page = state.currentPage;
    const pos = {
        x: Math.min(Math.max(0, screenPt.x), mapper.width - NOTE_SIZE),
        y: Math.min(Math.max(0, screenPt.y), mapper.height - NOTE_SIZE)
    };
    const color = noteUi.color.slice();
    runTask(async () => {
        let id = null;
        await editDocument(doc => { id = addNoteAnnot(doc, doc.getPage(page), mapper, pos, color, ''); }, { silent: true });
        if (!id || page !== state.currentPage) return;
        noteUi.open.add(id);
        const el = buildNoteEl({ id, x: pos.x, y: pos.y, color, text: '' });
        notesLayer().appendChild(el);
        el.querySelector('.pn-text').focus();
    });
}

function initNotes() {
    const palette = document.getElementById('note-palette');
    if (!palette) return;
    palette.innerHTML = NOTE_COLORS.map(([name, c], i) =>
        `<button type="button" class="note-swatch${i === 0 ? ' active' : ''}" data-i="${i}" title="${name}" style="background:${noteRgbCss(c)}"></button>`).join('');
    palette.addEventListener('click', e => {
        const btn = e.target.closest('.note-swatch');
        if (!btn) return;
        noteUi.color = NOTE_COLORS[parseInt(btn.dataset.i, 10)][1].slice();
        palette.querySelectorAll('.note-swatch').forEach(b => b.classList.toggle('active', b === btn));
    });
}

/* ---------- Buscador (Ctrl+F) ---------- */

// matches: [{ page, rects: [{x0,y0,x1,y1}] }] en coordenadas PDF
const search = { query: '', matches: [], index: -1, token: 0, scanning: false, timer: null };

const normalizeForSearch = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Rectángulo de la parte de la palabra que coincide (sólo en texto horizontal; si no, la palabra entera). */
function partialWordRect(w, len, a, b) {
    const whole = { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 };
    if (len <= 0 || (a <= 0 && b >= len) || Math.abs(w.dir.y) > 0.05 || w.dir.x < 0) return whole;
    const width = w.x1 - w.x0;
    return { x0: w.x0 + width * a / len, y0: w.y0, x1: w.x0 + width * b / len, y1: w.y1 };
}

function findMatchesInWords(words, q) {
    const norms = words.map(w => normalizeForSearch(w.text));
    const starts = [];
    let text = '';
    norms.forEach(n => { starts.push(text.length); text += n + ' '; });
    const found = [];
    let from = 0;
    let at;
    while ((at = text.indexOf(q, from)) !== -1) {
        const end = at + q.length;
        const rects = [];
        for (let i = 0; i < words.length; i++) {
            const s = starts[i], e = s + norms[i].length;
            if (e <= at || s >= end) continue;
            rects.push(partialWordRect(words[i], norms[i].length, Math.max(at, s) - s, Math.min(end, e) - s));
        }
        if (rects.length) found.push({ rects });
        from = end;
    }
    return found;
}

function updateSearchUi() {
    const n = search.matches.length;
    const hasQuery = !!search.query;
    ui.searchClear.hidden = !ui.searchInput.value;
    ui.searchPrev.disabled = ui.searchNext.disabled = n === 0;
    if (!hasQuery) ui.searchCount.textContent = '';
    else if (n) ui.searchCount.textContent = `${search.index + 1} de ${n}${search.scanning ? '…' : ''}`;
    else ui.searchCount.textContent = search.scanning ? '…' : 'Sin resultados';
}

/** Dibuja las coincidencias de la página actual; devuelve el elemento de la coincidencia activa. */
function renderSearchHighlights() {
    let layer = document.getElementById('search-layer');
    if (!layer) {
        layer = document.createElement('div');
        layer.id = 'search-layer';
    }
    if (layer.parentElement !== ui.pageWrapper) ui.pageWrapper.appendChild(layer);
    layer.replaceChildren();
    if (!state.pageMapper) return null;
    const z = state.zoomFactor;
    let current = null;
    search.matches.forEach((m, i) => {
        if (m.page !== state.currentPage) return;
        for (const r of m.rects) {
            const b = state.pageMapper.rectToScreen(r);
            const el = document.createElement('div');
            el.className = 'search-hit';
            el.style.cssText = `left:${b.x0 * z}px;top:${b.y0 * z}px;width:${(b.x1 - b.x0) * z}px;height:${(b.y1 - b.y0) * z}px`;
            if (i === search.index) {
                el.classList.add('current');
                current = current || el;
            }
            layer.appendChild(el);
        }
    });
    return current;
}

async function showSearchMatch() {
    const m = search.matches[search.index];
    updateSearchUi();
    if (!m) { renderSearchHighlights(); return; }
    if (m.page !== state.currentPage) {
        state.currentPage = m.page;
        await renderCurrentPage();
    } else {
        renderSearchHighlights();
    }
    setTimeout(() => {
        const cur = document.querySelector('#search-layer .search-hit.current');
        if (cur) cur.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    }, 60);
}

async function runSearch({ keepIndex = false } = {}) {
    const raw = ui.searchInput.value;
    search.query = normalizeForSearch(raw).replace(/\s+/g, ' ').trim();
    const prevIndex = search.index;
    const token = ++search.token;
    search.matches = [];
    search.index = -1;
    search.scanning = false;
    if (!search.query || !hasDocument() || !state.pdfJsDoc) {
        updateSearchUi();
        renderSearchHighlights();
        return;
    }

    const total = state.totalPages;
    const doc = state.pdfJsDoc;
    const order = [];
    for (let k = 0; k < total; k++) order.push((state.currentPage + k) % total);
    search.scanning = true;
    let navigated = false;
    for (const p of order) {
        let words;
        try { words = await getPageWords(p); } catch (e) { continue; }
        if (token !== search.token || doc !== state.pdfJsDoc) return;
        const found = findMatchesInWords(words, search.query).map(m => ({ page: p, rects: m.rects }));
        if (!found.length) continue;
        search.matches.push(...found);
        if (!keepIndex && !navigated) {
            // La primera coincidencia (desde la página actual) se muestra enseguida, sin esperar al resto
            navigated = true;
            search.index = 0;
            showSearchMatch();
        } else {
            updateSearchUi();
        }
    }
    search.scanning = false;
    const current = search.matches[search.index];
    search.matches.sort((a, b) => a.page - b.page);
    if (keepIndex) search.index = search.matches.length ? Math.min(Math.max(prevIndex, 0), search.matches.length - 1) : -1;
    else search.index = current ? search.matches.indexOf(current) : -1;
    updateSearchUi();
    renderSearchHighlights();
}

function stepSearch(delta) {
    const n = search.matches.length;
    if (!n || search.scanning) return;
    search.index = (search.index + delta + n) % n;
    showSearchMatch();
}

function clearSearch() {
    ui.searchInput.value = '';
    runSearch();
}

function focusSearch() {
    if (!hasDocument()) return;
    ui.searchInput.focus();
    ui.searchInput.select();
}

function initSearch() {
    ui.searchInput.addEventListener('input', () => {
        clearTimeout(search.timer);
        search.timer = setTimeout(() => { search.timer = null; runSearch(); }, 120);
    });
    ui.searchInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            // Si todavía hay una búsqueda pendiente se aplica primero
            if (search.timer) { clearTimeout(search.timer); search.timer = null; runSearch(); return; }
            stepSearch(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            clearSearch();
            ui.searchInput.blur();
        }
    });
    ui.searchPrev.addEventListener('click', () => stepSearch(-1));
    ui.searchNext.addEventListener('click', () => stepSearch(1));
    ui.searchClear.addEventListener('click', () => { clearSearch(); ui.searchInput.focus(); });
    updateSearchUi();
}

function isTextField(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
    if (el.closest && el.closest('.text-editor')) return true;
    return el.tagName === 'INPUT' && ['text', 'number', 'search'].includes(el.type);
}

function setupShortcuts() {
    document.addEventListener('keydown', e => {
        if (isAnyDialogOpen()) return;
        const ctrl = e.ctrlKey || e.metaKey;
        const key = e.key;
        const lower = key.length === 1 ? key.toLowerCase() : key;
        const inField = isTextField(e.target);

        if (pasteHint && key === 'Escape') { e.preventDefault(); hidePasteHint(); return; }

        // Esc en modo Nota: se deja de crear post-it y se vuelve a Navegar
        if (key === 'Escape' && state.currentMode === 'note' && !imageEditor && !textEditor && e.target !== ui.searchInput) {
            e.preventDefault();
            if (document.activeElement && document.activeElement.closest('.pn')) document.activeElement.blur();
            const nav = document.querySelector('input[name="mode"][value="navigate"]');
            if (nav) {
                nav.checked = true;
                nav.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return;
        }

        // Imagen en edición: Enter la aplica; Esc o Ctrl+Z cancelan; Supr la elimina
        if (imageEditor && !inField) {
            if (key === 'Enter') { e.preventDefault(); commitImageEditor(); return; }
            if (key === 'Delete' || key === 'Backspace') { e.preventDefault(); deleteImageEditor(); return; }
            if (key === 'Escape' || (ctrl && lower === 'z' && !e.shiftKey)) {
                e.preventDefault();
                cancelImageEditor();
                return;
            }
        }

        if (ctrl) {
            if (key === '1') {
                e.preventDefault();
                const r = document.querySelector('input[name="mode"][value="copy_text"]');
                if (r && !r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
            }
            else if (lower === 'o') { e.preventDefault(); openFileOrImage(); }
            else if (lower === 'f') { e.preventDefault(); focusSearch(); }
            else if (lower === 's') { e.preventDefault(); runTask(e.shiftKey ? savePdfAs : savePdf); }
            else if (lower === 'p') { e.preventDefault(); runTask(printPdf); }
            else if (lower === 'z' && e.shiftKey) { e.preventDefault(); runTask(redoAction); }
            else if (lower === 'z' && !inField) { e.preventDefault(); runTask(undoAction); }
            else if (lower === 'y' && !inField) { e.preventDefault(); runTask(redoAction); }
            else if (key === '+' || key === '=') { e.preventDefault(); zoomIn(); }
            else if (key === '-') { e.preventDefault(); zoomOut(); }
            return;
        }
        if (inField) return;
        if (key === 'Delete') { e.preventDefault(); runTask(deleteCurrentPage); }
        else if (key === 'ArrowLeft') { e.preventDefault(); prevPageShortcut(); }
        else if (key === 'ArrowRight') { e.preventDefault(); nextPageShortcut(); }
    });
}

initUi();
updateWindowTitle();
