/* =========================================================================
 * compress.js — "Comprimir PDF" (se baja sólo al usarlo).
 * Reduce el peso sin convertir las páginas en imágenes: el texto y los
 * vectores quedan intactos. Lo que hace:
 *   1. Re-comprime las imágenes grandes como JPEG (achicándolas si superan
 *      el tamaño máximo del nivel elegido). Sólo se reemplaza una imagen si
 *      el resultado pesa menos.
 *   2. Comprime los streams que estén guardados sin compresión.
 *   3. Elimina objetos huérfanos (restos de páginas borradas, etc.).
 *   4. Guarda con object streams.
 * Si el resultado no es más liviano, devuelve los bytes originales.
 * ========================================================================= */

const COMPRESS_LEVELS = {
    low:    { maxDim: 2400, quality: 0.82 },
    medium: { maxDim: 1700, quality: 0.68 },
    high:   { maxDim: 1150, quality: 0.5 }
};

// Imágenes más chicas que esto (en píxeles) no vale la pena tocarlas.
const COMPRESS_MIN_PIXELS = 160 * 160;

async function compressPdfBytes(bytes, level, onProgress) {
    const cfg = COMPRESS_LEVELS[level] || COMPRESS_LEVELS.medium;
    const { PDFName, PDFRawStream, PDFDict, PDFArray, PDFRef, PDFNumber, PDFBool } = PDFLib;
    await loadScript(PAKO_URL);

    const doc = await loadLibDoc(bytes);
    const ctx = doc.context;

    removeUnreachableObjects(ctx, { PDFRef, PDFDict, PDFArray, PDFRawStream });

    const nameOf = v => (v instanceof PDFName ? v.decodeText() : null);
    const lookup = v => (v instanceof PDFRef ? ctx.lookup(v) : v);

    // Imágenes que funcionan como máscara de otra: se dejan como están.
    const maskRefs = new Set();
    const streams = [];
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFRawStream)) continue;
        streams.push([ref, obj]);
        for (const key of ['SMask', 'Mask']) {
            const m = obj.dict.get(PDFName.of(key));
            if (m instanceof PDFRef) maskRefs.add(m.toString());
        }
    }

    const images = streams.filter(([ref, obj]) =>
        nameOf(obj.dict.get(PDFName.of('Subtype'))) === 'Image' && !maskRefs.has(ref.toString()));

    for (let i = 0; i < images.length; i++) {
        if (onProgress) onProgress(`Comprimiendo imágenes (${i + 1} de ${images.length})...`);
        const [ref, obj] = images[i];
        try {
            const out = await recompressImage(obj, cfg, { ctx, nameOf, lookup, PDFName, PDFNumber, PDFBool, PDFArray, PDFDict });
            if (out) ctx.assign(ref, out);
        } catch (e) {
            console.warn('No se pudo comprimir una imagen:', e);
        }
    }

    // Streams sin compresión (contenidos de página, fuentes, etc.).
    if (onProgress) onProgress('Optimizando el documento...');
    for (const [ref, obj] of streams) {
        const dict = obj.dict;
        if (dict.get(PDFName.of('Filter'))) continue;
        const type = nameOf(dict.get(PDFName.of('Type')));
        if (type === 'Metadata' || nameOf(dict.get(PDFName.of('Subtype'))) === 'Image') continue;
        if (obj.contents.length < 256) continue;
        const deflated = pako.deflate(obj.contents);
        if (deflated.length >= obj.contents.length) continue;
        const newDict = dict.clone(ctx);
        newDict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
        ctx.assign(ref, PDFRawStream.of(newDict, deflated));
    }

    const out = await doc.save({ useObjectStreams: true });
    return out.length < bytes.length ? out : bytes;
}

/** Devuelve un nuevo stream JPEG para la imagen, o null si no conviene / no se puede. */
async function recompressImage(obj, cfg, { ctx, nameOf, lookup, PDFName, PDFNumber, PDFBool, PDFArray, PDFDict }) {
    const dict = obj.dict;
    const get = k => lookup(dict.get(PDFName.of(k)));

    const imageMask = get('ImageMask');
    if (imageMask instanceof PDFBool && imageMask.asBoolean()) return null;
    if (get('Decode')) return null;

    const width = get('Width') instanceof PDFNumber ? get('Width').asNumber() : 0;
    const height = get('Height') instanceof PDFNumber ? get('Height').asNumber() : 0;
    if (!width || !height || width * height < COMPRESS_MIN_PIXELS) return null;

    // Filtro: un único DCTDecode o FlateDecode
    let filter = get('Filter');
    if (filter instanceof PDFArray) {
        if (filter.size() !== 1) return null;
        filter = lookup(filter.get(0));
    }
    const filterName = nameOf(filter);

    // Espacio de color: sólo gris o RGB (incluye ICCBased con 1 o 3 componentes)
    const components = colorComponents(get('ColorSpace'), { nameOf, lookup, PDFName, PDFArray, PDFDict, PDFNumber });
    if (components !== 1 && components !== 3) return null;

    let source; // algo dibujable en un canvas
    if (filterName === 'DCTDecode') {
        source = await createImageBitmap(new Blob([obj.contents], { type: 'image/jpeg' }));
    } else if (filterName === 'FlateDecode') {
        const bpc = get('BitsPerComponent');
        if (!(bpc instanceof PDFNumber) || bpc.asNumber() !== 8) return null;
        const parms = get('DecodeParms');
        const predictor = parms instanceof PDFDict ? lookup(parms.get(PDFName.of('Predictor'))) : null;
        if (predictor instanceof PDFNumber && predictor.asNumber() > 1) return null;
        const raw = pako.inflate(obj.contents);
        if (raw.length < width * height * components) return null;
        const imageData = new ImageData(width, height);
        const px = imageData.data;
        for (let p = 0, s = 0, n = width * height; p < n; p++, s += components) {
            const d = p * 4;
            if (components === 1) {
                px[d] = px[d + 1] = px[d + 2] = raw[s];
            } else {
                px[d] = raw[s]; px[d + 1] = raw[s + 1]; px[d + 2] = raw[s + 2];
            }
            px[d + 3] = 255;
        }
        source = await createImageBitmap(imageData);
    } else {
        return null;
    }

    const scale = Math.min(1, cfg.maxDim / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.imageSmoothingQuality = 'high';
    g.drawImage(source, 0, 0, w, h);
    if (source.close) source.close();

    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', cfg.quality));
    canvas.width = canvas.height = 0;
    if (!blob) return null;
    const jpeg = new Uint8Array(await blob.arrayBuffer());
    if (jpeg.length >= obj.contents.length * 0.9) return null; // no se gana lo suficiente

    const newDict = dict.clone(ctx);
    newDict.delete(PDFName.of('DecodeParms'));
    newDict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
    newDict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
    newDict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
    newDict.set(PDFName.of('Width'), PDFNumber.of(w));
    newDict.set(PDFName.of('Height'), PDFNumber.of(h));
    return PDFLib.PDFRawStream.of(newDict, jpeg);
}

/** Cantidad de componentes de color, o 0 si el espacio no está soportado. */
function colorComponents(cs, { nameOf, lookup, PDFArray, PDFDict, PDFName, PDFNumber }) {
    const n = nameOf(cs);
    if (n === 'DeviceGray' || n === 'CalGray') return 1;
    if (n === 'DeviceRGB' || n === 'CalRGB') return 3;
    if (cs instanceof PDFArray && cs.size() >= 2 && nameOf(lookup(cs.get(0))) === 'ICCBased') {
        const icc = lookup(cs.get(1));
        const d = icc && (icc.dict || (icc instanceof PDFDict ? icc : null));
        const num = d ? lookup(d.get(PDFName.of('N'))) : null;
        return num instanceof PDFNumber ? num.asNumber() : 0;
    }
    return 0;
}

/** Borra los objetos a los que no se llega desde el trailer (Root / Info). */
function removeUnreachableObjects(ctx, { PDFRef, PDFDict, PDFArray, PDFRawStream }) {
    const seen = new Set();
    const stack = [];
    const push = v => { if (v) stack.push(v); };
    push(ctx.trailerInfo.Root);
    push(ctx.trailerInfo.Info);
    push(ctx.trailerInfo.Encrypt);
    while (stack.length) {
        let v = stack.pop();
        if (v instanceof PDFRef) {
            const key = v.toString();
            if (seen.has(key)) continue;
            seen.add(key);
            v = ctx.lookup(v);
        }
        if (v instanceof PDFRawStream || (v && v.dict instanceof PDFDict)) v = v.dict;
        if (v instanceof PDFDict) {
            for (const [, val] of v.entries()) push(val);
        } else if (v instanceof PDFArray) {
            for (let i = 0; i < v.size(); i++) push(v.get(i));
        }
    }
    if (!seen.size) return; // por las dudas: sin raíz conocida no se borra nada
    for (const [ref] of ctx.enumerateIndirectObjects()) {
        if (!seen.has(ref.toString())) ctx.delete(ref);
    }
}
