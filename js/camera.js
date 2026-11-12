/* =========================================================================
 * camera.js
 * "Sacar foto" (celulares): la foto de la cámara nativa se muestra en una
 * vista previa con la opción de filtro "Escaneado" (alto contraste) y se
 * devuelve como JPEG para agregarla como página.
 * Se descarga sólo la primera vez que se usa (no pesa en la carga de la app).
 * ========================================================================= */

/* Lado mayor de la foto en el PDF: ~A4 a 200 ppp. Más resolución sólo agranda el archivo. */
const SCAN_MAX_SIDE = 2400;
const SCAN_JPEG_QUALITY = 0.85;

/** Decodifica la foto (respetando la orientación EXIF) en un canvas de tamaño acotado. */
async function photoToCanvas(file) {
    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const s = Math.min(1, SCAN_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * s);
        canvas.height = Math.round(img.naturalHeight * s);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas;
    } finally {
        URL.revokeObjectURL(url);
    }
}

/**
 * Filtro "Escaneado": pasa a escala de grises, compensa la iluminación despareja
 * (sombras de la mano, viñeteo) dividiendo por el fondo del papel y aplica niveles
 * de alto contraste para que el papel quede blanco y la tinta negra.
 */
function scanFilter(src) {
    const w = src.width, h = src.height;

    // Fondo del papel: la foto reducida a la mitad varias veces (promedia bien) y vuelta a agrandar
    let small = src, sw = w, sh = h;
    while (Math.max(sw, sh) > 48) {
        sw = Math.max(1, sw >> 1);
        sh = Math.max(1, sh >> 1);
        const c = document.createElement('canvas');
        c.width = sw;
        c.height = sh;
        const cx = c.getContext('2d');
        cx.imageSmoothingQuality = 'high';
        cx.drawImage(small, 0, 0, sw, sh);
        small = c;
    }
    const bg = document.createElement('canvas');
    bg.width = w;
    bg.height = h;
    const bgCtx = bg.getContext('2d');
    bgCtx.imageSmoothingQuality = 'high';
    bgCtx.drawImage(small, 0, 0, w, h);
    const b = bgCtx.getImageData(0, 0, w, h).data;

    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    const img = src.getContext('2d').getImageData(0, 0, w, h);
    const d = img.data;

    // Niveles sobre (gris / fondo): por debajo de BLACK es tinta (negro), por encima de WHITE es papel (blanco)
    const BLACK = 0.45, WHITE = 0.88, k = 255 / (WHITE - BLACK);
    for (let i = 0; i < d.length; i += 4) {
        const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        const bgG = b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114;
        let v = ((g / (bgG || 1)) - BLACK) * k;
        v = v < 0 ? 0 : v > 255 ? 255 : v;
        d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return out;
}

/**
 * Muestra la vista previa de la foto con "Original" / "Escaneado".
 * Devuelve un Blob JPEG listo para insertar, o null si se cancela.
 */
async function scanPhotoDialog(file) {
    const original = await photoToCanvas(file);
    let scanned = null;

    return new Promise(resolve => {
        const { dlg, body, footer } = createDialog('Sacar foto', { className: 'scan-dialog' });
        body.innerHTML = `
            <div class="dialog-row scan-modes">
                <label><input type="radio" name="scan-mode" value="original"> Original</label>
                <label><input type="radio" name="scan-mode" value="scan" checked> Escaneado</label>
            </div>
            <div class="scan-preview"></div>
        `;
        const preview = body.querySelector('.scan-preview');
        const mode = () => body.querySelector('input[name="scan-mode"]:checked').value;
        const show = () => {
            if (mode() === 'scan' && !scanned) scanned = scanFilter(original);
            preview.replaceChildren(mode() === 'scan' ? scanned : original);
        };
        body.querySelectorAll('input[name="scan-mode"]').forEach(r => r.addEventListener('change', show));

        let done = false;
        const finish = value => {
            if (done) return;
            done = true;
            closeDialog(dlg);
            resolve(value);
        };
        addDialogButton(footer, 'Agregar al PDF', () => {
            const canvas = mode() === 'scan' ? (scanned || (scanned = scanFilter(original))) : original;
            canvas.toBlob(blob => finish(blob), 'image/jpeg', SCAN_JPEG_QUALITY);
        }, { isDefault: true });
        addDialogButton(footer, 'Cancelar', () => finish(null));
        dlg.addEventListener('cancel', e => { e.preventDefault(); finish(null); });

        // Se muestra la foto original al instante y el filtro se aplica en el cuadro siguiente
        preview.replaceChildren(original);
        dlg.showModal();
        requestAnimationFrame(() => setTimeout(() => { if (!done) show(); }, 0));
    });
}
