/* =========================================================================
 * pdf-ops.js
 * Operaciones de edición sobre el PDF (equivalente a las llamadas a PyMuPDF
 * de B51.py) implementadas con pdf-lib. Todas las coordenadas "de pantalla"
 * se expresan en puntos de la página visualizada (origen arriba-izquierda,
 * con la rotación de la página ya aplicada, zoom = 1). Las coordenadas
 * "PDF" son las del espacio de usuario (origen abajo-izquierda, sin rotar).
 * ========================================================================= */

const { PDFDocument, PDFName, PDFRef, PDFArray, PDFDict, PDFString, PDFHexString, StandardFonts, degrees } = PDFLib;

const A4 = { w: 595.32, h: 841.92 };

/* ---------- Utilidades numéricas / geométricas ---------- */

function fmtNum(n) {
    const r = Math.round(n * 1000) / 1000;
    return (Object.is(r, -0) ? 0 : r).toString();
}

function colorOp(color, stroke) {
    return `${color.map(fmtNum).join(' ')} ${stroke ? 'RG' : 'rg'}`;
}

function rectFromPoints(points) {
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function rectIntersects(a, b) {
    if (a.x1 <= a.x0 || a.y1 <= a.y0 || b.x1 <= b.x0 || b.y1 <= b.y0) return false;
    return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function rectContains(r, pt) {
    return pt.x >= r.x0 && pt.x < r.x1 && pt.y >= r.y0 && pt.y < r.y1;
}

/**
 * Convierte entre coordenadas de pantalla (zoom 1) y coordenadas PDF para una
 * página con caja visible `view` = [x0, y0, x1, y1] y rotación `rotate`.
 */
function makePageMapper(view, rotate) {
    const [x0, y0, x1, y1] = view;
    const W = x1 - x0;
    const H = y1 - y0;
    const r = ((rotate % 360) + 360) % 360;
    const swapped = r === 90 || r === 270;
    return {
        width: swapped ? H : W,
        height: swapped ? W : H,
        rotate: r,
        toPdf(dx, dy) {
            switch (r) {
                case 90: return { x: x0 + dy, y: y0 + dx };
                case 180: return { x: x1 - dx, y: y0 + dy };
                case 270: return { x: x1 - dy, y: y1 - dx };
                default: return { x: x0 + dx, y: y1 - dy };
            }
        },
        /** Rectángulo de pantalla -> rectángulo PDF normalizado */
        rectToPdf(dx0, dy0, dx1, dy1) {
            return rectFromPoints([this.toPdf(dx0, dy0), this.toPdf(dx1, dy1)]);
        },
        /** Inversa de toPdf: punto PDF -> coordenadas de pantalla */
        toScreen(px, py) {
            switch (r) {
                case 90: return { x: py - y0, y: px - x0 };
                case 180: return { x: x1 - px, y: py - y0 };
                case 270: return { x: y1 - py, y: x1 - px };
                default: return { x: px - x0, y: y1 - py };
            }
        },
        /** Rectángulo PDF -> rectángulo de pantalla normalizado */
        rectToScreen(pr) {
            return rectFromPoints([this.toScreen(pr.x0, pr.y0), this.toScreen(pr.x1, pr.y1)]);
        }
    };
}

function mapperForLibPage(page) {
    const box = page.getCropBox();
    return makePageMapper([box.x, box.y, box.x + box.width, box.y + box.height], page.getRotation().angle);
}

/** Matriz que rota el contenido "en orientación de pantalla" para que se vea derecho en una página rotada. */
function rotationMatrix(rotate) {
    switch (rotate) {
        case 90: return [0, 1, -1, 0, 0, 0];
        case 180: return [-1, 0, 0, -1, 0, 0];
        case 270: return [0, -1, 1, 0, 0, 0];
        default: return [1, 0, 0, 1, 0, 0];
    }
}

/* ---------- Carga / guardado ---------- */

async function loadLibDoc(bytes) {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    if (doc.isEncrypted) {
        return rebuildEncryptedDoc(bytes);
    }
    return doc;
}

/** Escribe el texto de la página original como texto invisible (modo 3) sobre la imagen, para poder seleccionarlo/copiarlo. */
async function addInvisibleTextLayer(doc, outPage, srcPage, baseViewport, font) {
    const { pushOperators, beginText, endText, setFontAndSize, setTextMatrix, showText,
            setTextRenderingMode, PDFOperator, PDFNumber } = PDFLib;
    const content = await srcPage.getTextContent();
    outPage.setFont(font);
    const fontKey = outPage.fontKey;
    const safeCache = new Map();
    const safeChar = ch => {
        if (!safeCache.has(ch)) {
            let r = ch;
            try { font.encodeText(ch); } catch (e) { r = '?'; }
            safeCache.set(ch, r);
        }
        return safeCache.get(ch);
    };
    const ops = [];
    for (const item of content.items) {
        if (!item.str || !item.str.trim()) continue;
        const str = Array.from(item.str).map(safeChar).join('');
        const t = pdfjsLib.Util.transform(baseViewport.transform, item.transform);
        const size = Math.hypot(t[0], t[1]);
        if (!(size > 0)) continue;
        const natural = font.widthOfTextAtSize(str, size);
        const tz = natural > 0 && item.width > 0 ? (item.width / natural) * 100 : 100;
        const angle = -Math.atan2(t[1], t[0]);
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const x = t[4];
        const y = baseViewport.height - t[5];
        ops.push(
            beginText(),
            setTextRenderingMode(3),
            setFontAndSize(fontKey, size),
            PDFOperator.of('Tz', [PDFNumber.of(tz)]),
            setTextMatrix(cos, sin, -sin, cos, x, y),
            showText(font.encodeText(str)),
            endText()
        );
    }
    if (ops.length) outPage.pushOperators(...ops);
}

/**
 * PDF con restricciones (cifrado sin contraseña de apertura): pdf-lib no puede leerlo, pero pdf.js sí.
 * Se rasteriza cada página y se arma un PDF nuevo, sin cifrado, con el mismo tamaño de página.
 * Limitación: el texto del resultado deja de ser seleccionable/editable.
 */
async function rebuildEncryptedDoc(bytes) {
    let src;
    try {
        src = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    } catch (e) {
        throw new Error('El PDF requiere una contraseña para abrirse y no puede editarse.');
    }
    const out = await PDFDocument.create();
    const font = await out.embedFont(StandardFonts.Helvetica);
    const scale = 2;
    try {
        for (let n = 1; n <= src.numPages; n++) {
            const page = await src.getPage(n);
            const base = page.getViewport({ scale: 1 });
            const vp = page.getViewport({ scale });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(vp.width);
            canvas.height = Math.ceil(vp.height);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: ctx, viewport: vp }).promise;
            const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92));
            const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
            const outPage = out.addPage([base.width, base.height]);
            outPage.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
            canvas.width = canvas.height = 0;
            try {
                await addInvisibleTextLayer(out, outPage, page, base, font);
            } catch (e) {
                console.warn('No se pudo recuperar la capa de texto de la página', n, e);
            }
        }
    } finally {
        src.destroy();
    }
    return out;
}

/* ---------- Recursos y contenido de página ---------- */

function ensureSubDict(ctx, parent, key) {
    const name = PDFName.of(key);
    let dict = parent.lookupMaybe(name, PDFDict);
    if (!dict) {
        dict = ctx.obj({});
        parent.set(name, dict);
    }
    return dict;
}

function getPageResources(doc, page) {
    const node = page.node;
    let res = node.lookupMaybe(PDFName.of('Resources'), PDFDict);
    if (!res) {
        const inherited = node.Resources();
        res = inherited ? inherited.clone(doc.context) : doc.context.obj({});
        node.set(PDFName.of('Resources'), res);
    }
    return res;
}

function addXObjectToPage(doc, page, ref) {
    const res = getPageResources(doc, page);
    const xobjects = ensureSubDict(doc.context, res, 'XObject');
    let i = 0;
    let key;
    do { key = `ImStamp${i++}`; } while (xobjects.has(PDFName.of(key)));
    xobjects.set(PDFName.of(key), ref);
    return key;
}

/** Añade operadores al final del contenido de la página (overlay), protegiendo el estado gráfico previo. */
function appendPageContent(doc, page, ops) {
    const ctx = doc.context;
    const node = page.node;
    const contentsKey = PDFName.of('Contents');
    const existing = node.get(contentsKey);
    const newRef = ctx.register(ctx.stream(ops));
    let items;
    if (!existing) {
        items = [newRef];
    } else {
        const qRef = ctx.register(ctx.stream('q\n'));
        const QRef = ctx.register(ctx.stream('\nQ\n'));
        const resolved = ctx.lookup(existing);
        const old = resolved instanceof PDFArray ? resolved.asArray() : [existing];
        items = [qRef, ...old, QRef, newRef];
    }
    node.set(contentsKey, ctx.obj(items));
}

/* ---------- Imágenes ---------- */

async function embedImage(doc, img) {
    return img.type === 'jpg' ? doc.embedJpg(img.bytes) : doc.embedPng(img.bytes);
}

/**
 * Dibuja una imagen ocupando el rectángulo de pantalla (dx, dy, dw, dh) de la
 * página, respetando la rotación (equivalente a page.insert_image(rect, overlay=True)).
 */
function drawImageInScreenRect(doc, page, imageRef, mapper, dx, dy, dw, dh) {
    const p0 = mapper.toPdf(dx, dy + dh);        // esquina inferior izquierda de la imagen
    const p1 = mapper.toPdf(dx + dw, dy + dh);   // inferior derecha
    const p2 = mapper.toPdf(dx, dy);             // superior izquierda
    const m = [p1.x - p0.x, p1.y - p0.y, p2.x - p0.x, p2.y - p0.y, p0.x, p0.y].map(fmtNum).join(' ');
    const name = addXObjectToPage(doc, page, imageRef);
    appendPageContent(doc, page, `q ${m} cm /${name} Do Q`);
}

/** Inserta una página A4 con la imagen ajustada manteniendo la proporción (insert_image keep_proportion). */
async function insertImageAsA4Page(doc, img, index) {
    const image = await embedImage(doc, img);
    const page = doc.insertPage(index, [A4.w, A4.h]);
    const s = Math.min(A4.w / image.width, A4.h / image.height);
    const w = image.width * s;
    const h = image.height * s;
    page.drawImage(image, { x: (A4.w - w) / 2, y: (A4.h - h) / 2, width: w, height: h });
    return page;
}

/* ---------- Anotaciones ---------- */

let annotCounter = 0;

function addAnnotation(doc, page, { subtype, rect, extra = {}, ap }) {
    const ctx = doc.context;
    const apDict = {
        Type: 'XObject',
        Subtype: 'Form',
        FormType: 1,
        BBox: ap.bbox,
        Resources: ap.resources || {}
    };
    if (ap.matrix) apDict.Matrix = ap.matrix;
    const apRef = ctx.register(ctx.stream(ap.content, apDict));

    const dict = ctx.obj({
        Type: 'Annot',
        Subtype: subtype,
        Rect: [rect.x0, rect.y0, rect.x1, rect.y1],
        F: 4,
        P: page.ref,
        AP: { N: apRef },
        ...extra
    });
    dict.set(PDFName.of('M'), PDFString.fromDate(new Date()));
    dict.set(PDFName.of('NM'), PDFString.of(`web-${Date.now()}-${annotCounter++}`));
    const ref = ctx.register(dict);

    let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) {
        annots = ctx.obj([]);
        page.node.set(PDFName.of('Annots'), annots);
    }
    annots.push(ref);
    return ref;
}

function padRect(r, pad) {
    return { x0: r.x0 - pad, y0: r.y0 - pad, x1: r.x1 + pad, y1: r.y1 + pad };
}

/** page.add_rect_annot + set_colors(stroke) + set_border(width) */
function addRectAnnot(doc, page, r, color, width) {
    const w = width;
    const content = `${fmtNum(w)} w ${colorOp(color, true)} ` +
        `${fmtNum(r.x0 + w / 2)} ${fmtNum(r.y0 + w / 2)} ` +
        `${fmtNum(Math.max(0, r.x1 - r.x0 - w))} ${fmtNum(Math.max(0, r.y1 - r.y0 - w))} re S`;
    addAnnotation(doc, page, {
        subtype: 'Square',
        rect: r,
        extra: { C: color, BS: { W: w, S: 'S' } },
        ap: { bbox: [r.x0, r.y0, r.x1, r.y1], content }
    });
}

/** Rectángulo relleno semitransparente (fallback del resaltado cuando no hay texto). */
function addFilledRectAnnot(doc, page, r, color, opacity) {
    const content = `/GS0 gs ${colorOp(color, true)} ${colorOp(color, false)} 1 w ` +
        `${fmtNum(r.x0 + 0.5)} ${fmtNum(r.y0 + 0.5)} ${fmtNum(Math.max(0, r.x1 - r.x0 - 1))} ${fmtNum(Math.max(0, r.y1 - r.y0 - 1))} re B`;
    addAnnotation(doc, page, {
        subtype: 'Square',
        rect: r,
        extra: { C: color, IC: color, CA: opacity, BS: { W: 1, S: 'S' } },
        ap: {
            bbox: [r.x0, r.y0, r.x1, r.y1],
            content,
            resources: { ExtGState: { GS0: { Type: 'ExtGState', CA: opacity, ca: opacity } } }
        }
    });
}

/**
 * Tachado / subrayado: una anotación Line por renglón (así se pueden borrar con la goma).
 * segments: [{p1, p2, width}] en coordenadas PDF.
 */
function drawStrikeLines(doc, page, segments, color) {
    for (const s of segments) {
        const pad = Math.max(3, s.width * 2);
        const r = padRect(rectFromPoints([s.p1, s.p2]), pad);
        addAnnotation(doc, page, {
            subtype: 'Line',
            rect: r,
            extra: { C: color, L: [s.p1.x, s.p1.y, s.p2.x, s.p2.y], BS: { W: s.width, S: 'S' } },
            ap: {
                bbox: [r.x0, r.y0, r.x1, r.y1],
                content: `q 0 J ${colorOp(color, true)} ${fmtNum(s.width)} w ${fmtNum(s.p1.x)} ${fmtNum(s.p1.y)} m ${fmtNum(s.p2.x)} ${fmtNum(s.p2.y)} l S Q`
            }
        });
    }
}

/** page.add_highlight_annot(quads) */
function addHighlightAnnot(doc, page, rects, color) {
    const bounds = rectFromPoints(rects.flatMap(r => [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y1 }]));
    const quadPoints = rects.flatMap(r => [r.x0, r.y1, r.x1, r.y1, r.x0, r.y0, r.x1, r.y0]);
    const fills = rects.map(r => `${fmtNum(r.x0)} ${fmtNum(r.y0)} ${fmtNum(r.x1 - r.x0)} ${fmtNum(r.y1 - r.y0)} re`).join(' ');
    addAnnotation(doc, page, {
        subtype: 'Highlight',
        rect: bounds,
        extra: { C: color, QuadPoints: quadPoints },
        ap: {
            bbox: [bounds.x0, bounds.y0, bounds.x1, bounds.y1],
            content: `/GS0 gs ${colorOp(color, false)} ${fills} f`,
            resources: { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', CA: 1, ca: 1 } } }
        }
    });
}

/** page.add_line_annot + set_line_ends(NONE, OPEN_ARROW) */
function addArrowAnnot(doc, page, p1, p2, color, width) {
    const w = width;
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const ux = (p2.x - p1.x) / len;
    const uy = (p2.y - p1.y) / len;
    const head = Math.max(6, 3 * w);
    const ang = Math.PI / 6;
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const h1 = { x: p2.x - head * (ux * cos - uy * sin), y: p2.y - head * (uy * cos + ux * sin) };
    const h2 = { x: p2.x - head * (ux * cos + uy * sin), y: p2.y - head * (uy * cos - ux * sin) };
    const rect = padRect(rectFromPoints([p1, p2, h1, h2]), w);
    const P = p => `${fmtNum(p.x)} ${fmtNum(p.y)}`;
    const content = `${fmtNum(w)} w 1 J 1 j ${colorOp(color, true)} ` +
        `${P(p1)} m ${P(p2)} l S ${P(h1)} m ${P(p2)} l ${P(h2)} l S`;
    addAnnotation(doc, page, {
        subtype: 'Line',
        rect,
        extra: { L: [p1.x, p1.y, p2.x, p2.y], LE: ['None', 'OpenArrow'], C: color, BS: { W: w, S: 'S' } },
        ap: { bbox: [rect.x0, rect.y0, rect.x1, rect.y1], content }
    });
}

/* ---------- Notas (post-it): anotaciones Text con ícono de globo ---------- */

const NOTE_SIZE = 24;
const NOTE_PINNED_TITLE = 'Nota fijada';

/** Identificador estable de una nota: el mismo texto que usa pdf.js para la anotación ("12R"). */
function noteIdFromRef(ref) {
    return `${ref.objectNumber}R${ref.generationNumber || ''}`;
}

function noteRefFromId(id) {
    const m = /^(\d+)R(\d*)$/.exec(id);
    return m ? PDFRef.of(parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0) : null;
}

/** Globo de texto en el color de la nota (se ve en cualquier visor de PDF). */
function noteAppearance(color) {
    const dark = '0.25 0.25 0.25';
    return `q ${colorOp(color, false)} ${dark} RG 1 w ` +
        '2 8 20 13 re B 6 8 m 6 3 l 12 8 l h B ' +
        `${dark} RG 5 17 m 19 17 l S 5 14 m 19 14 l S 5 11 m 14 11 l S Q`;
}

function noteStream(doc, mapper, color) {
    const ctx = doc.context;
    return ctx.register(ctx.stream(noteAppearance(color), {
        Type: 'XObject', Subtype: 'Form', FormType: 1,
        BBox: [0, 0, NOTE_SIZE, NOTE_SIZE],
        Matrix: rotationMatrix(mapper.rotate)
    }));
}

/** Crea una nota con el ícono en (pos.x, pos.y) de pantalla; devuelve su id. */
function addNoteAnnot(doc, page, mapper, pos, color, text) {
    const rect = mapper.rectToPdf(pos.x, pos.y, pos.x + NOTE_SIZE, pos.y + NOTE_SIZE);
    const ref = addAnnotation(doc, page, {
        subtype: 'Text',
        rect,
        extra: { Contents: PDFHexString.fromText(text), C: color, Name: 'Comment' },
        ap: { bbox: [0, 0, NOTE_SIZE, NOTE_SIZE], content: noteAppearance(color), matrix: rotationMatrix(mapper.rotate) }
    });
    return noteIdFromRef(ref);
}

/** Modifica una nota existente: { text?, color?, pos? } (pos en coordenadas de pantalla). */
function updateNoteAnnot(doc, mapper, id, { text, color, pos, pinned }) {
    const ctx = doc.context;
    const ref = noteRefFromId(id);
    const dict = ref && ctx.lookupMaybe(ref, PDFDict);
    if (!dict) return false;
    if (text !== undefined) dict.set(PDFName.of('Contents'), PDFHexString.fromText(text));
    if (color) dict.set(PDFName.of('C'), ctx.obj(color));
    if (pinned !== undefined) {
        // "Fijada" (siempre visible): Open = true y título T = NOTE_PINNED_TITLE (pdf.js expone el título)
        dict.set(PDFName.of('Open'), ctx.obj(!!pinned));
        if (pinned) dict.set(PDFName.of('T'), PDFHexString.fromText(NOTE_PINNED_TITLE));
        else dict.delete(PDFName.of('T'));
    }
    if (pos) {
        const r = mapper.rectToPdf(pos.x, pos.y, pos.x + NOTE_SIZE, pos.y + NOTE_SIZE);
        dict.set(PDFName.of('Rect'), ctx.obj([r.x0, r.y0, r.x1, r.y1]));
    }
    if (color || pos) {
        const cur = dict.lookupMaybe(PDFName.of('C'), PDFArray);
        const c = color || (cur && cur.size() === 3 ? cur.asArray().map(n => ctx.lookup(n).asNumber()) : [1, 0.9, 0.4]);
        dict.set(PDFName.of('AP'), ctx.obj({ N: noteStream(doc, mapper, c) }));
    }
    dict.set(PDFName.of('M'), PDFString.fromDate(new Date()));
    return true;
}

function deleteNoteAnnot(doc, page, id) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) return false;
    for (let i = 0; i < annots.size(); i++) {
        const ref = annots.get(i);
        if (ref instanceof PDFRef && noteIdFromRef(ref) === id) {
            annots.remove(i);
            return true;
        }
    }
    return false;
}

/** Línea recta simple (sin punta de flecha). */
function addLineAnnot(doc, page, p1, p2, color, width) {
    const w = width;
    const rect = padRect(rectFromPoints([p1, p2]), w);
    const P = p => `${fmtNum(p.x)} ${fmtNum(p.y)}`;
    const content = `${fmtNum(w)} w 1 J 1 j ${colorOp(color, true)} ${P(p1)} m ${P(p2)} l S`;
    addAnnotation(doc, page, {
        subtype: 'Line',
        rect,
        extra: { L: [p1.x, p1.y, p2.x, p2.y], C: color, BS: { W: w, S: 'S' } },
        ap: { bbox: [rect.x0, rect.y0, rect.x1, rect.y1], content }
    });
}

/** page.add_ink_annot([stroke]) */
function addInkAnnot(doc, page, points, color, width) {
    const w = width;
    const rect = padRect(rectFromPoints(points), w);
    const path = points.map((p, i) => `${fmtNum(p.x)} ${fmtNum(p.y)} ${i === 0 ? 'm' : 'l'}`).join(' ');
    addAnnotation(doc, page, {
        subtype: 'Ink',
        rect,
        extra: { InkList: [points.flatMap(p => [p.x, p.y])], C: color, BS: { W: w, S: 'S' } },
        ap: { bbox: [rect.x0, rect.y0, rect.x1, rect.y1], content: `${fmtNum(w)} w 1 J 1 j ${colorOp(color, true)} ${path} S` }
    });
}

function sanitizeForFont(font, text) {
    let out = '';
    for (const ch of text.replace(/\t/g, '    ').replace(/\r\n?/g, '\n')) {
        if (ch === '\n') { out += ch; continue; }
        try { font.encodeText(ch); out += ch; } catch (e) { out += '?'; }
    }
    return out;
}

function wrapText(font, text, size, maxWidth) {
    const lines = [];
    for (const paragraph of text.split(/\r?\n/)) {
        const words = paragraph.split(' ');
        let line = '';
        for (const word of words) {
            const candidate = line ? `${line} ${word}` : word;
            if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) {
                line = candidate;
            } else {
                lines.push(line);
                line = word;
            }
        }
        lines.push(line);
    }
    return lines;
}

/* ---------- Fuentes del texto libre ---------- */

/** Variantes de cada familia: índice = (negrita ? 1 : 0) + (cursiva ? 2 : 0). */
const FONT_VARIANTS = ['Rg', 'Bo', 'It', 'BI'];
const fontVariantIndex = (bold, italic) => (bold ? 1 : 0) + (italic ? 2 : 0);

const expoFontUrls = (pkg, name) => ['400Regular', '700Bold', '400Regular_Italic', '700Bold_Italic']
    .map(v => `https://cdn.jsdelivr.net/npm/@expo-google-fonts/${pkg}/${v}/${name}_${v}.ttf`);

/**
 * Familias disponibles. Helvetica, Times y Courier son fuentes estándar del PDF (no se incrustan).
 * Arial y Comic Sans se toman de las fuentes instaladas en el equipo (Local Font Access API);
 * si el navegador no lo permite se usan equivalentes libres (Arimo y Comic Neue). Montserrat se descarga.
 */
const TEXT_FONT_FAMILIES = {
    He: { label: 'Helvetica', css: 'Helvetica, Arial, sans-serif',
          std: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique] },
    Ti: { label: 'Times New Roman', css: '"Times New Roman", Times, serif',
          std: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic] },
    Ar: { label: 'Arial', css: 'Arial, Arimo, sans-serif',
          local: ['ArialMT', 'Arial-BoldMT', 'Arial-ItalicMT', 'Arial-BoldItalicMT'], urls: expoFontUrls('arimo', 'Arimo'),
          // El recorte (subset) de pdf-lib pierde glifos de Arial/Arimo: se incrusta la fuente completa
          subset: false },
    Co: { label: 'Courier', css: '"Courier New", Courier, monospace',
          std: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique] },
    Cs: { label: 'Comic Sans', css: '"Comic Sans MS", "Comic Neue", cursive',
          local: ['ComicSansMS', 'ComicSansMS-Bold', 'ComicSansMS-Italic', 'ComicSansMS-BoldItalic'], urls: expoFontUrls('comic-neue', 'ComicNeue') },
    Mo: { label: 'Montserrat', css: 'Montserrat, sans-serif', urls: expoFontUrls('montserrat', 'Montserrat') }
};

// Nombres de recurso de versiones anteriores (se siguen usando para poder reabrir esos textos)
const LEGACY_FONT_NAMES = { Helv: ['He', 0], HeBo: ['He', 1], TiRo: ['Ti', 0], TiBo: ['Ti', 1], Cour: ['Co', 0], CoBo: ['Co', 1] };

/** Nombre del recurso de fuente en el PDF para una familia + variante (p. ej. "MoBI"). */
function fontResourceName(family, variant) {
    const legacy = Object.keys(LEGACY_FONT_NAMES)
        .find(k => LEGACY_FONT_NAMES[k][0] === family && LEGACY_FONT_NAMES[k][1] === variant);
    return legacy || `${family}${FONT_VARIANTS[variant]}`;
}

/** Inverso de fontResourceName: devuelve { family, bold, italic } o null si no es una fuente propia. */
function parseFontResourceName(name) {
    let family, variant;
    if (LEGACY_FONT_NAMES[name]) [family, variant] = LEGACY_FONT_NAMES[name];
    else {
        const m = /^([A-Z][a-z])(Rg|Bo|It|BI)$/.exec(name);
        if (!m || !TEXT_FONT_FAMILIES[m[1]]) return null;
        family = m[1];
        variant = FONT_VARIANTS.indexOf(m[2]);
    }
    return { family, bold: (variant & 1) === 1, italic: (variant & 2) === 2 };
}

const FONTKIT_URL = 'https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js';
const fontBytesCache = new Map();

/**
 * Bytes TTF de una fuente no estándar (se cachean). Conviene llamarla al elegir la fuente
 * (con el clic del usuario) para que el navegador pueda pedir permiso de fuentes locales.
 */
function loadTextFontBytes(family, variant) {
    const fam = TEXT_FONT_FAMILIES[family];
    if (!fam || fam.std) return Promise.resolve(null);
    const key = family + variant;
    if (!fontBytesCache.has(key)) {
        const p = (async () => {
            if (fam.local && window.queryLocalFonts) {
                try {
                    const [local] = await window.queryLocalFonts({ postscriptNames: [fam.local[variant]] });
                    if (local) return new Uint8Array(await (await local.blob()).arrayBuffer());
                } catch (e) { /* permiso denegado o no disponible: se usa la alternativa libre */ }
            }
            const res = await fetch(fam.urls[variant]);
            if (!res.ok) throw new Error(`No se pudo descargar la fuente ${fam.label}`);
            return new Uint8Array(await res.arrayBuffer());
        })();
        p.catch(() => fontBytesCache.delete(key));
        fontBytesCache.set(key, p);
    }
    return fontBytesCache.get(key);
}

/** Incrusta la fuente del estilo en el documento. Sin conexión cae en Helvetica con la misma variante. */
async function embedTextFont(doc, family, variant) {
    const fam = TEXT_FONT_FAMILIES[family] || TEXT_FONT_FAMILIES.He;
    if (fam.std) return { font: await doc.embedFont(fam.std[variant]), family };
    try {
        const [bytes] = await Promise.all([loadTextFontBytes(family, variant), loadScript(FONTKIT_URL)]);
        doc.registerFontkit(window.fontkit);
        return { font: await doc.embedFont(bytes, { subset: fam.subset !== false }), family };
    } catch (e) {
        console.warn('Fuente no disponible, se usa Helvetica:', e);
        return { font: await doc.embedFont(TEXT_FONT_FAMILIES.He.std[variant]), family: 'He' };
    }
}

const FREETEXT_PAD = 2;

/**
 * page.add_freetext_annot(rect, text, fontsize, text_color, fill_color=None) + set_border(0).
 * `screenBox` = {x, y, w?, h?} en coordenadas de pantalla; si no se indica w/h la caja se ajusta al texto.
 * `style` = { family, bold, italic, strike }. El texto se dibuja derecho aunque la página esté rotada.
 */
async function addFreeTextAnnot(doc, page, mapper, screenBox, text, fontSize, color, style = {}) {
    const variant = fontVariantIndex(style.bold, style.italic);
    const embedded = await embedTextFont(doc, TEXT_FONT_FAMILIES[style.family] ? style.family : 'He', variant);
    const font = embedded.font;
    const fontKey = fontResourceName(embedded.family, variant);
    const clean = sanitizeForFont(font, text);
    const pad = FREETEXT_PAD;
    const leading = fontSize * 1.2;

    let { x, y, w, h } = screenBox;
    let lines;
    if (w) {
        lines = wrapText(font, clean, fontSize, w - pad * 2);
    } else {
        lines = clean.split('\n');
        w = Math.max(...lines.map(l => font.widthOfTextAtSize(l, fontSize))) + pad * 2 + 1;
    }
    if (!h) h = pad * 2 + fontSize * 0.2 + leading * lines.length;
    const rect = mapper.rectToPdf(x, y, x + w, y + h);

    let baseline = h - pad - fontSize * 0.95;
    const textOps = [];
    const strikeOps = [];
    for (const line of lines) {
        if (line) {
            textOps.push(`1 0 0 1 ${fmtNum(pad)} ${fmtNum(baseline)} Tm ${font.encodeText(line).toString()} Tj`);
            if (style.strike) {
                // Tachado: línea a la altura media de las minúsculas
                const y = baseline + fontSize * 0.3;
                strikeOps.push(`${fmtNum(pad)} ${fmtNum(y)} m ${fmtNum(pad + font.widthOfTextAtSize(line, fontSize))} ${fmtNum(y)} l S`);
            }
        }
        baseline -= leading;
    }
    const strikeContent = strikeOps.length
        ? ` ${colorOp(color, true)} ${fmtNum(Math.max(0.5, fontSize * 0.06))} w ${strikeOps.join(' ')}`
        : '';
    const content = `/Tx BMC q BT /${fontKey} ${fmtNum(fontSize)} Tf ${colorOp(color, false)} ${textOps.join(' ')} ET${strikeContent} Q EMC`;

    const extra = {
        Contents: PDFHexString.fromText(text),
        DA: PDFString.of(`/${fontKey} ${fmtNum(fontSize)} Tf ${colorOp(color, false)}`),
        BS: { W: 0 },
        Border: [0, 0, 0]
    };
    if (style.strike) extra.WebStrike = 1;

    addAnnotation(doc, page, {
        subtype: 'FreeText',
        rect,
        extra,
        ap: {
            bbox: [0, 0, w, h],
            matrix: rotationMatrix(mapper.rotate),
            content,
            resources: { Font: { [fontKey]: font.ref } }
        }
    });
}

/**
 * Busca una anotación de texto libre que contenga el punto PDF `pt`; si la encuentra
 * la quita de la página y devuelve sus datos { text, family, bold, italic, strike, fontSize, color, rect }.
 */
function takeFreeTextAt(doc, page, pt) {
    const ctx = doc.context;
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) return null;
    for (let i = annots.size() - 1; i >= 0; i--) {
        const dict = annots.lookup(i, PDFDict);
        if (!dict) continue;
        const subtype = dict.get(PDFName.of('Subtype'));
        if (!subtype || subtype.toString() !== '/FreeText') continue;
        const rectArr = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
        if (!rectArr) continue;
        const nums = rectArr.asArray().map(n => ctx.lookup(n).asNumber());
        const rect = rectFromPoints([{ x: nums[0], y: nums[1] }, { x: nums[2], y: nums[3] }]);
        if (!rectContains(rect, pt)) continue;

        const contents = dict.lookup(PDFName.of('Contents'));
        const text = contents && contents.decodeText ? contents.decodeText() : '';
        const daObj = dict.lookup(PDFName.of('DA'));
        const da = daObj && daObj.decodeText ? daObj.decodeText() : '';
        const fm = /\/(\S+)\s+([\d.]+)\s+Tf/.exec(da);
        const cm = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
        const fontInfo = (fm && parseFontResourceName(fm[1])) || { family: 'He', bold: false, italic: false };
        const strikeObj = dict.lookup(PDFName.of('WebStrike'));
        annots.remove(i);
        return {
            text,
            ...fontInfo,
            strike: !!(strikeObj && strikeObj.asNumber && strikeObj.asNumber()),
            fontSize: fm ? parseFloat(fm[2]) || 14 : 14,
            color: cm ? [1, 2, 3].map(k => parseFloat(cm[k])) : [0, 0, 0],
            rect
        };
    }
    return null;
}

/**
 * Coloca una imagen como anotación Stamp en el rectángulo de pantalla (x, y, w, h).
 * Se guarda una copia de la imagen original (/WebImg) para poder reubicarla o
 * redimensionarla más adelante, incluso después de guardar y reabrir el PDF.
 */
async function addImageStampAnnot(doc, page, mapper, img, x, y, w, h) {
    const ctx = doc.context;
    const embedded = await embedImage(doc, img);
    const dataRef = ctx.register(ctx.stream(img.bytes, {}));
    addAnnotation(doc, page, {
        subtype: 'Stamp',
        rect: mapper.rectToPdf(x, y, x + w, y + h),
        extra: { WebImg: dataRef, WebImgType: img.type === 'jpg' ? 'jpg' : 'png', WebImgRot: mapper.rotate },
        ap: {
            bbox: [0, 0, w, h],
            matrix: rotationMatrix(mapper.rotate),
            content: `q ${fmtNum(w)} 0 0 ${fmtNum(h)} 0 0 cm /Im0 Do Q`,
            resources: { XObject: { Im0: embedded.ref } }
        }
    });
}

/**
 * Busca (de arriba hacia abajo) una imagen colocada con addImageStampAnnot que contenga el punto PDF `pt`;
 * si la encuentra la quita de la página y devuelve { bytes, type, rotate, rect }.
 */
function takeImageStampAt(doc, page, pt) {
    const ctx = doc.context;
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) return null;
    for (let i = annots.size() - 1; i >= 0; i--) {
        const dict = annots.lookup(i, PDFDict);
        if (!dict || !dict.get(PDFName.of('WebImg'))) continue;
        const rectArr = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
        if (!rectArr) continue;
        const nums = rectArr.asArray().map(n => ctx.lookup(n).asNumber());
        const rect = rectFromPoints([{ x: nums[0], y: nums[1] }, { x: nums[2], y: nums[3] }]);
        if (!rectContains(rect, pt)) continue;

        const stream = dict.lookup(PDFName.of('WebImg'));
        let bytes;
        try { bytes = PDFLib.decodePDFRawStream(stream).decode(); } catch (e) { bytes = stream.contents; }
        const typeObj = dict.get(PDFName.of('WebImgType'));
        const rotObj = dict.lookup(PDFName.of('WebImgRot'));
        annots.remove(i);
        return {
            bytes,
            type: typeObj && typeObj.toString() === '/jpg' ? 'jpg' : 'png',
            rotate: rotObj && rotObj.asNumber ? rotObj.asNumber() : 0,
            rect
        };
    }
    return null;
}

/** Recorre page.first_annot ... annot.next y borra la primera cuyo rect contiene el punto. */
function deleteAnnotationAt(doc, page, pt) {
    const ctx = doc.context;
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) return false;
    for (let i = 0; i < annots.size(); i++) {
        const dict = annots.lookup(i, PDFDict);
        if (!dict) continue;
        const subtype = dict.get(PDFName.of('Subtype'));
        const st = subtype ? subtype.toString() : '';
        if (st === '/Link' || st === '/Widget' || st === '/Popup') continue;
        const rectArr = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
        if (!rectArr) continue;
        const nums = rectArr.asArray().map(n => ctx.lookup(n).asNumber());
        const r = rectFromPoints([{ x: nums[0], y: nums[1] }, { x: nums[2], y: nums[3] }]);
        if (rectContains(r, pt)) {
            const popupRef = dict.get(PDFName.of('Popup'));
            annots.remove(i);
            if (popupRef) {
                for (let j = 0; j < annots.size(); j++) {
                    if (annots.get(j) === popupRef) { annots.remove(j); break; }
                }
            }
            return true;
        }
    }
    return false;
}

/* ---------- Operaciones de documento ---------- */

async function reorderDocument(doc, order) {
    const out = await PDFDocument.create();
    const pages = await out.copyPages(doc, order);
    pages.forEach(p => out.addPage(p));
    return out;
}

async function extractPagesToNewDoc(doc, indices) {
    return reorderDocument(doc, indices);
}

/** Inserta las páginas de otro PDF en `index` conservando su tamaño original. Devuelve la cantidad insertada. */
async function insertPdfBytes(doc, bytes, index) {
    const src = await loadLibDoc(bytes);
    const pages = await doc.copyPages(src, src.getPageIndices());
    pages.forEach((p, i) => doc.insertPage(index + i, p));
    return pages.length;
}
