/* =========================================================================
 * remote-camera.js
 * "Foto con celular" (compu): se muestra un QR; el celular lo escanea, abre la
 * app en modo cámara y cada foto que se acepta allá llega a la compu como página
 * nueva. La foto viaja directo de un dispositivo al otro (WebRTC, con PeerJS);
 * el servidor público de PeerJS sólo pone en contacto a los dos con un código.
 * Este módulo y sus librerías se bajan sólo al usar la función.
 * ========================================================================= */

/* Librerías con versión fija y control de integridad (SRI): si el archivo del CDN
   no coincide con la huella, el navegador no lo ejecuta. */
const PEERJS_LIB = {
    url: 'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.5/peerjs.min.js',
    integrity: 'sha384-x0YgkOr/3UOZP2CRDxGW9e0Q+2Qjyr3uJrm4xU32Y7ZCNAo7Cc7bjhrZMi/dwczu'
};
const QRGEN_LIB = {
    url: 'https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/dist/qrcode.js',
    integrity: 'sha384-e9EFD6BGC90bkW9aDV5xbbBfzwN7G8YImHao2lfLVKV/hPB0E0go+H3I64h7oHtA'
};

const REMOTE_PEER_PREFIX = 'cuervopdf-';
const REMOTE_URL_PARAM = 'celu';
const REMOTE_MAX_PHOTO_BYTES = 25 * 1024 * 1024;

const secureLibs = new Map();

/** Carga una librería externa con su hash de integridad (una sola vez). */
function loadSecureLib({ url, integrity }) {
    if (!secureLibs.has(url)) {
        secureLibs.set(url, new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url;
            s.integrity = integrity;
            s.crossOrigin = 'anonymous';
            s.onload = resolve;
            s.onerror = () => {
                secureLibs.delete(url); // se puede reintentar (p. ej. sin conexión)
                reject(new Error('No se pudo cargar un componente necesario. Revisá la conexión a internet.'));
            };
            document.head.appendChild(s);
        }));
    }
    return secureLibs.get(url);
}

/** Código al azar para emparejar (10 caracteres, sin letras que se confundan). */
function randomPairCode() {
    const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    return Array.from(bytes, b => abc[b % abc.length]).join('');
}

function isJpegBytes(bytes) {
    return bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
}

function peerErrorMessage(err) {
    switch (err && err.type) {
        case 'peer-unavailable': return 'No se encontró la compu. Volvé a abrir "Foto con celular" en la compu y escaneá el QR nuevo.';
        case 'browser-incompatible': return 'Este navegador no permite la conexión. Probá con Chrome o Safari actualizados.';
        case 'network':
        case 'server-error':
        case 'socket-error':
        case 'socket-closed': return 'No se pudo conectar. Revisá la conexión a internet.';
        default: return `No se pudo conectar: ${(err && err.message) || err}`;
    }
}

/* =========================================================================
 * Compu: QR + recepción de fotos
 * ========================================================================= */

let remoteSession = null; // { peer, conn, chip, dlg, count }

function remoteChip() {
    const s = remoteSession;
    if (!s.chip) {
        const chip = document.createElement('div');
        chip.className = 'remote-chip';
        chip.setAttribute('role', 'status');
        chip.innerHTML = `${icon('device-mobile-camera')}<span class="remote-chip-text"></span>`;
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.textContent = 'Desconectar';
        stop.addEventListener('click', endRemoteSession);
        chip.appendChild(stop);
        document.body.appendChild(chip);
        s.chip = chip;
    }
    return s.chip;
}

function setRemoteChip(text) {
    if (!remoteSession) return;
    remoteChip().querySelector('.remote-chip-text').textContent = text;
}

function endRemoteSession() {
    const s = remoteSession;
    if (!s) return;
    remoteSession = null;
    if (s.dlg) closeDialog(s.dlg);
    if (s.chip) s.chip.remove();
    try { s.peer.destroy(); } catch (_) { /* ya estaba cerrada */ }
}


/* Errores del servidor de contacto que no tiene sentido reintentar */
const REMOTE_FATAL_ERRORS = ['browser-incompatible', 'invalid-id', 'invalid-key', 'ssl-unavailable'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Espera hasta que `test()` dé true (o se agote el tiempo). */
async function waitUntil(test, ms) {
    const end = Date.now() + ms;
    while (!test()) {
        if (Date.now() > end) return false;
        await sleep(150);
    }
    return true;
}

function photoCountText(n) {
    return `${n} ${n === 1 ? 'foto recibida' : 'fotos recibidas'}`;
}

/** Mensajes del celular: ping (¿seguís ahí?) y fotos. Cada foto tiene un id: si llega dos veces se agrega una sola. */
function handlePhoneMessage(session, conn, data) {
    if (!data) return;
    if (data.t === 'ping') { conn.send({ t: 'pong', id: data.id }); return; }
    if (data.t !== 'photo') return;
    const id = String(data.id || '');
    if (session.received.has(id)) { conn.send({ t: 'ok', id }); return; } // reenvío de una que ya llegó
    const bytes = data.b instanceof ArrayBuffer ? new Uint8Array(data.b) : (data.b instanceof Uint8Array ? data.b : null);
    if (!bytes || bytes.length > REMOTE_MAX_PHOTO_BYTES || !isJpegBytes(bytes)) {
        conn.send({ t: 'error', id, msg: 'La compu no pudo leer la foto.' });
        return;
    }
    session.received.add(id);
    runTask(async () => {
        await loadOrMergeDroppedFiles([new File([bytes], 'Foto.jpg', { type: 'image/jpeg' })]);
        if (remoteSession !== session) return;
        session.count++;
        setRemoteChip(`Celular conectado · ${photoCountText(session.count)}`);
        showStatus('Foto recibida del celular.', 4000, 'device-mobile-camera');
    }).finally(() => {
        // Se confirma por la conexión activa (el celu pudo reconectarse mientras se agregaba)
        const c = session.conn && session.conn.open ? session.conn : conn;
        try { c.send({ t: 'ok', id }); } catch (_) { /* el celu reintenta y se confirma por el id */ }
    });
}

/** Crea (o vuelve a crear) el punto de contacto de la compu con el código del QR. */
function createDesktopPeer(session) {
    const peer = new Peer(REMOTE_PEER_PREFIX + session.code);
    session.peer = peer;
    peer.on('open', () => { session.everOpen = true; session.retries = 0; });

    peer.on('connection', conn => {
        if (remoteSession !== session) { conn.close(); return; }
        conn.on('open', () => {
            const old = session.conn;
            session.conn = conn; // la más nueva es la que vale (el celu volvió a conectarse)
            if (old && old !== conn) try { old.close(); } catch (_) { /* ya estaba cerrada */ }
            if (session.dlg) { closeDialog(session.dlg); session.dlg = null; }
            setRemoteChip(session.count ? `Celular conectado · ${photoCountText(session.count)}` : 'Celular conectado · sacá la foto desde el celu');
        });
        conn.on('data', data => { if (remoteSession === session) handlePhoneMessage(session, conn, data); });
        conn.on('close', () => {
            if (remoteSession !== session || session.conn !== conn) return; // se cerró una conexión vieja
            session.conn = null;
            setRemoteChip('Esperando al celular…');
        });
        conn.on('error', err => console.warn(err));
    });

    // Si se corta el contacto con el servidor se reintenta; la conexión con el celu no depende de eso
    peer.on('disconnected', () => {
        setTimeout(() => { if (remoteSession === session && session.peer === peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 1000);
    });
    peer.on('close', () => {
        // Se cerró del todo por un error: se vuelve a crear con el mismo código (el QR sigue sirviendo)
        if (remoteSession !== session || session.peer !== peer || !session.everOpen) return;
        if (++session.retries > 20) return;
        setTimeout(() => { if (remoteSession === session && session.peer === peer) createDesktopPeer(session); }, 2000);
    });
    peer.on('error', err => {
        if (remoteSession !== session || session.peer !== peer) return;
        console.warn(err);
        if (err.type === 'peer-unavailable') return;
        // Antes de mostrar el QR, un error es definitivo; después, se reintenta solo
        if (!session.everOpen || REMOTE_FATAL_ERRORS.includes(err.type)) {
            endRemoteSession();
            msgCritical('Foto con celular', peerErrorMessage(err));
        }
    });
    return peer;
}

/** Botón "Foto con celular": muestra el QR y espera al celular. */
async function openRemoteCamera() {
    if (remoteSession) {
        // Ya hay una sesión: se vuelve a mostrar el QR (p. ej. para conectar de nuevo)
        if (!remoteSession.dlg) showRemoteQrDialog();
        return;
    }
    await Promise.all([loadSecureLib(PEERJS_LIB), loadSecureLib(QRGEN_LIB)]);
    remoteSession = { peer: null, conn: null, chip: null, dlg: null, count: 0, code: randomPairCode(), received: new Set(), everOpen: false, retries: 0 };
    createDesktopPeer(remoteSession);
    showRemoteQrDialog();
}

function showRemoteQrDialog() {
    const s = remoteSession;
    const url = `${location.origin}${location.pathname}?${REMOTE_URL_PARAM}=${s.code}`;
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();

    const { dlg, body, footer } = createDialog('Foto con celular', { className: 'remote-dialog' });
    body.innerHTML = `
        <div class="remote-qr">${qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true })}</div>
        <ol class="remote-steps">
            <li>Abrí la cámara del celular y apuntá a este código.</li>
            <li>Tocá el enlace que aparece y sacá la foto.</li>
            <li>Al aceptarla en el celu, la foto se agrega acá como página nueva.</li>
        </ol>
        <p class="remote-state">Preparando la conexión…</p>
    `;
    const state = body.querySelector('.remote-state');
    waitUntil(() => !dlg.isConnected || (s.peer && s.peer.open), 30000).then(ok => {
        if (dlg.isConnected) state.textContent = ok ? 'Esperando al celular…' : 'No se pudo preparar la conexión. Revisá internet.';
    });

    addDialogButton(footer, s.conn ? 'Cerrar' : 'Cancelar', () => {
        closeDialog(dlg);
        if (remoteSession === s) s.dlg = null;
        if (!s.conn && !s.chip) endRemoteSession(); // nunca se conectó: se cierra todo
    }, { isDefault: true });
    dlg.addEventListener('cancel', e => { e.preventDefault(); footer.querySelector('button').click(); });
    s.dlg = dlg;
    dlg.showModal();
}

/* =========================================================================
 * Celular: modo cámara conectado a la compu
 * Al abrir la cámara el navegador queda en segundo plano y la conexión puede
 * cortarse o quedar "colgada". Por eso antes de enviar se verifica que la compu
 * responda; si no, se reconecta y se reintenta solo (la foto no se pierde).
 * ========================================================================= */

async function startPhoneCameraMode(code) {
    document.body.classList.add('remote-phone-mode');
    const screen = document.createElement('div');
    screen.className = 'remote-phone';
    screen.innerHTML = `
        <div class="remote-phone-card">
            <div class="remote-phone-icon">${icon('device-mobile-camera')}</div>
            <h1>Foto con celular</h1>
            <p class="remote-phone-state">Conectando con la compu…</p>
            <button type="button" class="remote-phone-shoot default">${icon('camera')} Sacar foto</button>
            <button type="button" class="remote-phone-retry" hidden>Reintentar envío</button>
            <p class="remote-phone-count"></p>
            <button type="button" class="remote-phone-exit">Salir</button>
        </div>
    `;
    document.body.appendChild(screen);
    const stateEl = screen.querySelector('.remote-phone-state');
    const shootBtn = screen.querySelector('.remote-phone-shoot');
    const retryBtn = screen.querySelector('.remote-phone-retry');
    const countEl = screen.querySelector('.remote-phone-count');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.hidden = true;
    screen.appendChild(input);

    const target = REMOTE_PEER_PREFIX + code;
    let peer = null, conn = null, linking = null, sending = false, closed = false, sent = 0, msgSeq = 0;
    let pending = null; // { id, blob }: foto aceptada que la compu todavía no confirmó
    let lastError = null;
    const waiters = new Map(); // id → función que recibe la respuesta de la compu (pong / ok / error)

    const setState = (text, ok = false) => {
        stateEl.textContent = text;
        stateEl.classList.toggle('ok', ok);
    };

    const waitReply = (id, ms) => new Promise(resolve => {
        const t = setTimeout(() => { waiters.delete(id); resolve(null); }, ms);
        waiters.set(id, data => { clearTimeout(t); waiters.delete(id); resolve(data); });
    });

    const dropConn = () => {
        const c = conn;
        conn = null;
        if (c) try { c.close(); } catch (_) { /* ya estaba cerrada */ }
    };

    const makePeer = () => {
        const p = new Peer();
        p.on('disconnected', () => {
            setTimeout(() => { if (!closed && peer === p && !p.destroyed && p.disconnected) p.reconnect(); }, 1000);
        });
        p.on('error', err => { console.warn(err); lastError = err; });
        return p;
    };

    /** ¿La compu responde por esta conexión? */
    const ping = async (c, ms) => {
        const id = `p${++msgSeq}`;
        try { c.send({ t: 'ping', id }); } catch (_) { return false; }
        return !!(await waitReply(id, ms));
    };

    /** Devuelve una conexión con la compu que ya respondió; si hace falta, reconecta. */
    const link = async () => {
        if (conn && conn.open && await ping(conn, 3000)) return conn;
        dropConn();
        if (!peer || peer.destroyed) peer = makePeer();
        else if (peer.disconnected) peer.reconnect();
        lastError = null;
        await waitUntil(() => closed || peer.open || (lastError && REMOTE_FATAL_ERRORS.includes(lastError.type)), 12000);
        if (!peer.open) {
            const err = lastError;
            try { peer.destroy(); } catch (_) { /* nada */ }
            peer = null; // la próxima vez se crea uno nuevo
            throw err || new Error('No se pudo conectar. Revisá la conexión a internet.');
        }
        lastError = null;
        const c = peer.connect(target, { reliable: true });
        c.on('data', data => {
            if (data && data.id && waiters.has(data.id)) waiters.get(data.id)(data);
        });
        c.on('close', () => {
            if (conn !== c || closed) return; // se cerró una conexión vieja: no afecta a la actual
            conn = null;
            if (!sending) setState('Se cortó la conexión. Reconectando…');
        });
        c.on('error', err => console.warn(err));
        await waitUntil(() => closed || c.open || (lastError && lastError.type === 'peer-unavailable'), 12000);
        if (!c.open) {
            try { c.close(); } catch (_) { /* nada */ }
            throw lastError || new Error('La compu no responde.');
        }
        conn = c;
        return c;
    };
    const ensureLink = () => {
        if (!linking) linking = link().finally(() => { linking = null; });
        return linking;
    };

    /** Conecta y actualiza el mensaje (al abrir, al volver de la cámara y cada tanto). */
    const refresh = async () => {
        if (closed || sending) return;
        if (!(conn && conn.open)) setState('Conectando con la compu…');
        try {
            await ensureLink();
            if (!sending && !closed) setState(pending ? 'Conectado. Tocá "Reintentar envío".' : 'Conectado con la compu.', true);
        } catch (e) {
            if (!sending && !closed) setState(peerErrorMessage(e));
        }
    };

    /** Envía la foto pendiente; si algo falla, reconecta y reintenta (la compu descarta duplicados). */
    const sendPending = async () => {
        if (!pending || sending) return;
        sending = true;
        shootBtn.disabled = true;
        retryBtn.hidden = true;
        const { id, blob } = pending;
        let lastFail = null;
        try {
            const bytes = await blob.arrayBuffer();
            for (let attempt = 1; attempt <= 3 && !closed; attempt++) {
                setState(attempt === 1 ? 'Enviando la foto…' : 'Reconectando y reenviando la foto…');
                try {
                    const c = await ensureLink();
                    const reply = waitReply(id, 45000);
                    c.send({ t: 'photo', id, b: bytes });
                    const r = await reply;
                    if (r && r.t === 'ok') {
                        pending = null;
                        sent++;
                        countEl.textContent = `${sent} ${sent === 1 ? 'foto enviada' : 'fotos enviadas'} ✓`;
                        setState('¡Listo! La foto ya está en la compu.', true);
                        return;
                    }
                    if (r && r.t === 'error') { lastFail = new Error(r.msg); pending = null; break; }
                    dropConn(); // sin respuesta: la conexión quedó colgada
                } catch (e) {
                    lastFail = e;
                    await sleep(1500);
                }
            }
            if (pending) {
                retryBtn.hidden = false;
                setState(`No se pudo enviar la foto. ${lastFail ? peerErrorMessage(lastFail) : 'La compu no responde.'}`);
            } else if (lastFail) {
                setState(lastFail.message);
            }
        } finally {
            sending = false;
            shootBtn.disabled = false;
        }
    };

    // Al volver de la cámara (o de otra app) se revisa la conexión enseguida
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    // Cada tanto se verifica que la compu siga del otro lado
    const heartbeat = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 8000);

    screen.querySelector('.remote-phone-exit').addEventListener('click', () => {
        closed = true;
        clearInterval(heartbeat);
        document.removeEventListener('visibilitychange', onVisible);
        try { if (peer) peer.destroy(); } catch (_) { /* nada */ }
        history.replaceState(null, '', location.pathname); // la app sigue normal, sin el modo cámara
        screen.remove();
        document.body.classList.remove('remote-phone-mode');
    });

    // Sacar foto no depende de la conexión: se verifica recién al enviar
    shootBtn.addEventListener('click', () => {
        input.value = '';
        input.click();
    });
    retryBtn.addEventListener('click', sendPending);

    input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        ensureLink().catch(() => { /* se reintenta al enviar */ }); // se reconecta mientras se ajusta la foto
        try {
            await loadScript(CAMERA_JS_URL);
            const blob = await scanPhotoDialog(file, { okLabel: 'Enviar a la compu' });
            if (!blob) return;
            pending = { id: `${Date.now().toString(36)}${randomPairCode()}`, blob };
            await sendPending();
        } catch (e) {
            console.error(e);
            setState(`No se pudo preparar la foto: ${e.message || e}`);
        }
    });

    try {
        await loadSecureLib(PEERJS_LIB);
    } catch (e) {
        setState(e.message || String(e));
        return;
    }
    loadScript(CAMERA_JS_URL).catch(e => console.warn(e)); // la vista previa se baja mientras tanto
    refresh();
}
