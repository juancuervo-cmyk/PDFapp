/* =========================================================================
 * camera.js
 * "Sacar foto" (celulares): la foto de la cámara nativa se muestra en una
 * vista previa donde se detecta la hoja (4 esquinas arrastrables), se puede
 * elegir Original o Escaneado, y al agregarla se recorta y endereza la hoja.
 * Todo en JS propio (sin OpenCV ni otras librerías) y se descarga sólo la
 * primera vez que se usa: no pesa en la carga de la app.
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

function grayOf(data, n) {
    const g = new Float32Array(n);
    for (let i = 0, j = 0; j < n; i += 4, j++) g[j] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    return g;
}

/** Desenfoque de caja separable (radio r) sobre una imagen de un canal. */
function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let s = 0, n = 0;
            for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { s += src[y * w + k]; n++; }
            tmp[y * w + x] = s / n;
        }
    }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let s = 0, n = 0;
            for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { s += tmp[k * w + x]; n++; }
            out[y * w + x] = s / n;
        }
    }
    return out;
}

/* ---------- Detección de la hoja ---------- */

/**
 * Busca la hoja en la foto: se reduce a ~360 px, se separa lo claro (papel) del fondo
 * con el umbral de Otsu, se toma la mancha clara más grande y sus 4 esquinas extremas.
 * Devuelve [sup-izq, sup-der, inf-der, inf-izq] en píxeles de la foto, o null si no la encuentra.
 */
function detectSheet(src) {
    const W = src.width, H = src.height;
    const s = Math.min(1, 360 / Math.max(W, H));
    const w = Math.max(8, Math.round(W * s)), h = Math.max(8, Math.round(H * s));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(src, 0, 0, w, h);
    const g = boxBlur(grayOf(cx.getImageData(0, 0, w, h).data, w * h), w, h, 2);
    const n = w * h;

    // Umbral de Otsu
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[g[i] | 0]++;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = -1, t = 128;
    for (let i = 0; i < 256; i++) {
        wB += hist[i];
        if (!wB) continue;
        const wF = n - wB;
        if (!wF) break;
        sumB += i * hist[i];
        const mB = sumB / wB, mF = (sum - sumB) / wF;
        const v = wB * wF * (mB - mF) * (mB - mF);
        if (v > best) { best = v; t = i; }
    }

    // Mancha clara más grande (relleno por inundación con pila)
    const label = new Int32Array(n);
    const stack = new Int32Array(n);
    let bestLabel = 0, bestArea = 0, cur = 0;
    for (let i = 0; i < n; i++) {
        if (label[i] || g[i] <= t) continue;
        cur++;
        let sp = 0, area = 0;
        stack[sp++] = i;
        label[i] = cur;
        while (sp) {
            const p = stack[--sp];
            area++;
            const x = p % w, y = (p - x) / w;
            if (x > 0 && !label[p - 1] && g[p - 1] > t) { label[p - 1] = cur; stack[sp++] = p - 1; }
            if (x < w - 1 && !label[p + 1] && g[p + 1] > t) { label[p + 1] = cur; stack[sp++] = p + 1; }
            if (y > 0 && !label[p - w] && g[p - w] > t) { label[p - w] = cur; stack[sp++] = p - w; }
            if (y < h - 1 && !label[p + w] && g[p + w] > t) { label[p + w] = cur; stack[sp++] = p + w; }
        }
        if (area > bestArea) { bestArea = area; bestLabel = cur; }
    }
    if (bestArea < n * 0.12) return null;

    // Esquinas: extremos de x+y y x−y dentro de la mancha
    let minS = Infinity, maxS = -Infinity, minD = Infinity, maxD = -Infinity;
    let tl, br, tr, bl;
    for (let i = 0; i < n; i++) {
        if (label[i] !== bestLabel) continue;
        const x = i % w, y = (i - x) / w;
        const sm = x + y, df = x - y;
        if (sm < minS) { minS = sm; tl = [x, y]; }
        if (sm > maxS) { maxS = sm; br = [x + 1, y + 1]; }
        if (df > maxD) { maxD = df; tr = [x + 1, y]; }
        if (df < minD) { minD = df; bl = [x, y + 1]; }
    }
    const quad = [tl, tr, br, bl].map(([x, y]) => [Math.min(W, x / s), Math.min(H, y / s)]);
    const a = quadArea(quad);
    if (a < W * H * 0.12 || a > W * H * 0.97) return null; // muy chica o es toda la foto
    return quad;
}

function quadArea(q) {
    let a = 0;
    for (let i = 0; i < 4; i++) {
        const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4];
        a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
}

function fullQuad(W, H) {
    return [[0, 0], [W, 0], [W, H], [0, H]];
}

/** Ordena 4 puntos como sup-izq, sup-der, inf-der, inf-izq (por si se cruzaron al arrastrar). */
function orderQuad(q) {
    const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
    const sorted = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    // atan2 ordena en sentido horario empezando por arriba-izquierda (ángulo más negativo)
    let start = 0, bestSum = Infinity;
    sorted.forEach((p, i) => { if (p[0] + p[1] < bestSum) { bestSum = p[0] + p[1]; start = i; } });
    return [0, 1, 2, 3].map(i => sorted[(start + i) % 4]);
}

/* ---------- Enderezado (transformación de perspectiva) ---------- */

/** Homografía que lleva el rectángulo w×h a la cuadrilátera `q` (resuelve el sistema 8×8). */
function homography(w, h, q) {
    const from = [[0, 0], [w, 0], [w, h], [0, h]];
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
        const [u, v] = from[i], [x, y] = q[i];
        A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
        A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    for (let col = 0; col < 8; col++) {
        let piv = col;
        for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
        [A[col], A[piv]] = [A[piv], A[col]];
        [b[col], b[piv]] = [b[piv], b[col]];
        for (let r = 0; r < 8; r++) {
            if (r === col) continue;
            const f = A[r][col] / A[col][col];
            for (let k = col; k < 8; k++) A[r][k] -= f * A[col][k];
            b[r] -= f * b[col];
        }
    }
    return b.map((v, i) => v / A[i][i]);
}

/** Recorta y endereza la hoja marcada por `quad` (interpolación bilineal). */
function warpSheet(src, quad) {
    const q = orderQuad(quad);
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    let w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
    let h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    const s = Math.min(1, SCAN_MAX_SIDE / Math.max(w, h));
    w = Math.max(1, Math.round(w * s));
    h = Math.max(1, Math.round(h * s));

    const [a, b, c, d, e, f, g, k] = homography(w, h, q);
    const SW = src.width, SH = src.height;
    const sd = src.getContext('2d').getImageData(0, 0, SW, SH).data;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    const img = ctx.createImageData(w, h);
    const od = img.data;
    let o = 0;
    for (let v = 0; v < h; v++) {
        const vy = v + 0.5;
        for (let u = 0; u < w; u++, o += 4) {
            const ux = u + 0.5;
            const z = g * ux + k * vy + 1;
            let x = (a * ux + b * vy + c) / z - 0.5;
            let y = (d * ux + e * vy + f) / z - 0.5;
            x = x < 0 ? 0 : x > SW - 1 ? SW - 1 : x;
            y = y < 0 ? 0 : y > SH - 1 ? SH - 1 : y;
            const x0 = x | 0, y0 = y | 0;
            const x1 = x0 < SW - 1 ? x0 + 1 : x0, y1 = y0 < SH - 1 ? y0 + 1 : y0;
            const fx = x - x0, fy = y - y0;
            const i00 = (y0 * SW + x0) * 4, i10 = (y0 * SW + x1) * 4, i01 = (y1 * SW + x0) * 4, i11 = (y1 * SW + x1) * 4;
            for (let ch = 0; ch < 3; ch++) {
                const top = sd[i00 + ch] + (sd[i10 + ch] - sd[i00 + ch]) * fx;
                const bot = sd[i01 + ch] + (sd[i11 + ch] - sd[i01 + ch]) * fx;
                od[o + ch] = top + (bot - top) * fy;
            }
            od[o + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    return out;
}

/* ---------- Filtro "Escaneado" ---------- */

/**
 * Pasa a escala de grises y compensa la iluminación despareja dividiendo por el
 * brillo del papel. El papel se estima con el MÁXIMO local (no el promedio), así
 * los bloques oscuros grandes (un QR, un sello) no se "lavan". Los niveles son
 * suaves para que lo borroso o tenue (letras, QR) quede gris legible y no blanco.
 */
function scanFilter(src) {
    const w = src.width, h = src.height;
    const ctx0 = src.getContext('2d');
    const img = ctx0.getImageData(0, 0, w, h);
    const d = img.data;
    const g = grayOf(d, w * h);

    // Brillo del papel: máximo por bloques de B×B, dilatado y suavizado, en baja resolución.
    // B es proporcional al tamaño (8 px a 2400 px) para que la vista previa chica se vea igual.
    const B = Math.max(2, Math.round(Math.max(w, h) / 300));
    const sw = Math.ceil(w / B), sh = Math.ceil(h / B);
    const blk = new Float32Array(sw * sh);
    for (let y = 0; y < h; y++) {
        const by = (y / B) | 0;
        for (let x = 0; x < w; x++) {
            const bi = by * sw + ((x / B) | 0);
            const v = g[y * w + x];
            if (v > blk[bi]) blk[bi] = v;
        }
    }
    const R = 7; // dilatación: ventanas de ~(2R+1)·B px cubren los módulos oscuros de un QR
    const dil = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
            let m = 0;
            for (let yy = Math.max(0, y - R); yy <= Math.min(sh - 1, y + R); yy++) {
                for (let xx = Math.max(0, x - R); xx <= Math.min(sw - 1, x + R); xx++) {
                    const v = blk[yy * sw + xx];
                    if (v > m) m = v;
                }
            }
            dil[y * sw + x] = m;
        }
    }
    const bg = boxBlur(dil, sw, sh, 3);

    // Curva (gris / papel) → salida, precalculada: negro por debajo de 0.2, blanco desde 0.93,
    // con gamma > 1 para que los grises medios queden más oscuros (legibles)
    const LUT_N = 1024;
    const lut = new Uint8ClampedArray(LUT_N + 1);
    const BLACK = 0.2, WHITE = 0.93, GAMMA = 1.35;
    for (let i = 0; i <= LUT_N; i++) {
        let t = (i / LUT_N * 1.25 - BLACK) / (WHITE - BLACK); // índice cubre razones 0 … 1.25
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        lut[i] = 255 * Math.pow(t, GAMMA);
    }

    for (let y = 0; y < h; y++) {
        // fondo interpolado bilinealmente entre bloques
        const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / B - 0.5));
        const y0 = fy | 0, y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
        for (let x = 0; x < w; x++) {
            const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / B - 0.5));
            const x0 = fx | 0, x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
            const top = bg[y0 * sw + x0] + (bg[y0 * sw + x1] - bg[y0 * sw + x0]) * tx;
            const bot = bg[y1 * sw + x0] + (bg[y1 * sw + x1] - bg[y1 * sw + x0]) * tx;
            const paper = top + (bot - top) * ty;
            const p = y * w + x;
            let idx = (g[p] / (paper > 1 ? paper : 1) / 1.25 * LUT_N) | 0;
            if (idx > LUT_N) idx = LUT_N;
            const i4 = p * 4;
            d[i4] = d[i4 + 1] = d[i4 + 2] = lut[idx];
        }
    }
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d').putImageData(img, 0, 0);
    return out;
}

/* ---------- Pantalla de la foto: resultado arriba, esquinas abajo ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg';
const PREVIEW_MAX_SIDE = 640; // la vista previa en vivo trabaja sobre una copia chica (rápida al arrastrar)

/** Ajusta el tamaño en pantalla de `el` (proporción cw:ch) para que entre en `box`. */
function fitInto(el, box, cw, ch, pad = 0) {
    const s = Math.min((box.clientWidth - pad) / cw, (box.clientHeight - pad) / ch);
    el.style.width = `${Math.max(1, Math.floor(cw * s))}px`;
    el.style.height = `${Math.max(1, Math.floor(ch * s))}px`;
}

function downscale(src, maxSide) {
    const s = Math.min(1, maxSide / Math.max(src.width, src.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * s));
    c.height = Math.max(1, Math.round(src.height * s));
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(src, 0, 0, c.width, c.height);
    return c;
}

/** PDF de una sola hoja A4 con la imagen (JPEG) ajustada. */
async function jpegToPdfFile(blob, name) {
    const doc = await PDFDocument.create();
    await insertImageAsA4Page(doc, { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'jpg' }, 0);
    return new File([await doc.save()], name, { type: 'application/pdf' });
}

function scanFileName() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `Escaneo ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.pdf`;
}

/**
 * Pantalla única de la foto:
 *  - arriba, el resultado (hoja recortada y enderezada) que se actualiza en vivo;
 *  - abajo, la foto con las 4 esquinas arrastrables;
 *  - Original / Escaneado, Compartir (PDF de una hoja), Cancelar y Agregar al PDF.
 * Devuelve un Blob JPEG para agregar al documento, o null si se cancela.
 */
async function scanPhotoDialog(file) {
    const original = await photoToCanvas(file);
    const W = original.width, H = original.height;
    const small = downscale(original, PREVIEW_MAX_SIDE);
    const ks = small.width / W;
    const detected = detectSheet(original);
    const FULL = fullQuad(W, H);
    let quad = (detected || FULL).map(p => p.slice());

    return new Promise(resolve => {
        const { dlg, body, footer } = createDialog('Sacar foto', { className: 'scan-dialog' });
        body.innerHTML = `
            <div class="dialog-row scan-modes">
                <label><input type="radio" name="scan-mode" value="original" checked> Original</label>
                <label><input type="radio" name="scan-mode" value="scan"> Escaneado</label>
            </div>
            <div class="scan-result"><canvas></canvas></div>
            <div class="scan-edit"><div class="scan-stage"></div></div>
            <div class="scan-hint">
                <span class="scan-msg">Arrastrá los puntos a las esquinas de la hoja.</span>
                <button type="button" class="scan-full"></button>
            </div>
        `;
        const resultBox = body.querySelector('.scan-result');
        const resultCanvas = resultBox.querySelector('canvas');
        const editBox = body.querySelector('.scan-edit');
        const stage = body.querySelector('.scan-stage');
        const fullBtn = body.querySelector('.scan-full');
        const msg = body.querySelector('.scan-msg');
        const mode = () => body.querySelector('input[name="scan-mode"]:checked').value;
        const isFull = () => quad.every((p, i) => Math.abs(p[0] - FULL[i][0]) < 1 && Math.abs(p[1] - FULL[i][1]) < 1);

        // Capa SVG en coordenadas de la foto: sombra fuera de la hoja, borde y 4 puntos
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.classList.add('scan-overlay');
        const shade = document.createElementNS(SVG_NS, 'path');
        shade.setAttribute('fill-rule', 'evenodd');
        shade.classList.add('scan-shade');
        const edge = document.createElementNS(SVG_NS, 'polygon');
        edge.classList.add('scan-edge');
        svg.append(shade, edge);
        const handles = quad.map((_, i) => {
            const hit = document.createElementNS(SVG_NS, 'circle'); // zona táctil grande e invisible
            hit.classList.add('scan-hit');
            const dot = document.createElementNS(SVG_NS, 'circle');
            dot.classList.add('scan-dot');
            hit.dataset.i = i;
            svg.append(dot, hit);
            return { hit, dot };
        });
        stage.append(original, svg);

        /* Resultado en vivo (sobre la copia chica, a lo sumo una vez por cuadro) */
        let previewQueued = false;
        const renderPreview = () => {
            previewQueued = false;
            if (done) return;
            let c = warpSheet(small, quad.map(([x, y]) => [x * ks, y * ks]));
            if (mode() === 'scan') c = scanFilter(c);
            resultCanvas.width = c.width;
            resultCanvas.height = c.height;
            resultCanvas.getContext('2d').drawImage(c, 0, 0);
            fitInto(resultCanvas, resultBox, c.width, c.height, 16);
        };
        const queuePreview = () => {
            if (previewQueued) return;
            previewQueued = true;
            requestAnimationFrame(renderPreview);
        };

        const draw = () => {
            fitInto(stage, editBox, W, H);
            const k = W / Math.max(1, stage.clientWidth);
            edge.setAttribute('points', quad.map(p => p.join(',')).join(' '));
            edge.style.strokeWidth = 2 * k;
            shade.setAttribute('d', `M0 0H${W}V${H}H0Z M${quad.map(p => p.join(' ')).join(' L')}Z`);
            handles.forEach(({ hit, dot }, i) => {
                for (const el of [hit, dot]) {
                    el.setAttribute('cx', quad[i][0]);
                    el.setAttribute('cy', quad[i][1]);
                }
                hit.setAttribute('r', 22 * k);
                dot.setAttribute('r', 9 * k);
                dot.style.strokeWidth = 2.5 * k;
            });
            fullBtn.textContent = isFull() && detected ? 'Detectar hoja' : 'Toda la foto';
            fullBtn.hidden = isFull() && !detected;
            queuePreview();
        };

        let dragging = null;
        svg.addEventListener('pointerdown', e => {
            if (!e.target.classList.contains('scan-hit')) return;
            dragging = +e.target.dataset.i;
            svg.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        svg.addEventListener('pointermove', e => {
            if (dragging === null) return;
            const r = svg.getBoundingClientRect();
            quad[dragging] = [
                Math.min(W, Math.max(0, (e.clientX - r.left) / r.width * W)),
                Math.min(H, Math.max(0, (e.clientY - r.top) / r.height * H))
            ];
            draw();
        });
        const endDrag = () => { dragging = null; };
        svg.addEventListener('pointerup', endDrag);
        svg.addEventListener('pointercancel', endDrag);

        fullBtn.addEventListener('click', () => {
            quad = (fullBtn.textContent === 'Detectar hoja' ? detected : FULL).map(p => p.slice());
            draw();
        });
        body.querySelectorAll('input[name="scan-mode"]').forEach(r => r.addEventListener('change', queuePreview));

        /* Imagen final en alta resolución (se reutiliza si no cambió nada entre Compartir y Agregar) */
        let cache = null;
        const finalBlob = () => {
            const key = mode() + quad.join(';');
            if (cache && cache.key === key) return cache.blob;
            let canvas = isFull() ? original : warpSheet(original, quad);
            if (mode() === 'scan') canvas = scanFilter(canvas); // sobre la hoja ya recortada
            const blob = new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('No se pudo generar la imagen.'))), 'image/jpeg', SCAN_JPEG_QUALITY));
            cache = { key, blob, pdf: null };
            return blob;
        };

        let done = false;
        const finish = value => {
            if (done) return;
            done = true;
            window.removeEventListener('resize', draw);
            closeDialog(dlg);
            resolve(value);
        };

        /* Compartir: PDF de una sola hoja por el menú de compartir del celular */
        const shareBtn = addDialogButton(footer, '', async () => {
            shareBtn.disabled = true;
            try {
                const entry = (finalBlob(), cache); // la entrada de la imagen actual
                const blob = await entry.blob;
                if (!entry.pdf) entry.pdf = jpegToPdfFile(blob, scanFileName());
                const pdf = await entry.pdf;
                if (navigator.canShare && navigator.canShare({ files: [pdf] })) {
                    try {
                        await navigator.share({ files: [pdf], title: pdf.name });
                    } catch (e) {
                        // Si armar el PDF tardó, el navegador puede pedir otro toque: ya queda listo
                        if (e.name === 'NotAllowedError') msg.textContent = 'El PDF ya está listo: tocá Compartir de nuevo.';
                        else if (e.name !== 'AbortError') throw e;
                    }
                } else {
                    downloadBlob(pdf, pdf.name); // sin menú de compartir (p. ej. en la compu): se descarga
                }
            } catch (e) {
                console.error(e);
                msg.textContent = `No se pudo compartir: ${e.message || e}`;
            } finally {
                shareBtn.disabled = false;
            }
        });
        shareBtn.classList.add('scan-share');
        shareBtn.title = 'Compartir como PDF (WhatsApp, mail…)';
        shareBtn.setAttribute('aria-label', 'Compartir como PDF');
        shareBtn.innerHTML = icon('share-network');

        addDialogButton(footer, 'Cancelar', () => finish(null));
        addDialogButton(footer, 'Agregar al PDF', async () => {
            try {
                finish(await finalBlob());
            } catch (e) {
                console.error(e);
                msg.textContent = `No se pudo generar la imagen: ${e.message || e}`;
            }
        }, { isDefault: true });
        dlg.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
        window.addEventListener('resize', draw);

        dlg.showModal();
        draw(); // con el diálogo ya visible, para medir el espacio disponible
    });
}
