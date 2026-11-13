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

/** Una foto que llega del celular se agrega como página (después de la actual, o documento nuevo). */
function receiveRemotePhoto(conn, data) {
    if (!data || data.t !== 'photo') return;
    const bytes = data.b instanceof ArrayBuffer ? new Uint8Array(data.b) : (data.b instanceof Uint8Array ? data.b : null);
    if (!bytes || bytes.length > REMOTE_MAX_PHOTO_BYTES || !isJpegBytes(bytes)) {
        conn.send({ t: 'error', msg: 'La compu no pudo leer la foto.' });
        return;
    }
    runTask(async () => {
        await loadOrMergeDroppedFiles([new File([bytes], 'Foto.jpg', { type: 'image/jpeg' })]);
        if (!remoteSession) return;
        remoteSession.count++;
        conn.send({ t: 'ok' });
        setRemoteChip(`Celular conectado · ${remoteSession.count} ${remoteSession.count === 1 ? 'foto recibida' : 'fotos recibidas'}`);
        showStatus('Foto recibida del celular.', 4000, 'device-mobile-camera');
    });
}

/** Botón "Foto con celular": muestra el QR y espera al celular. */
async function openRemoteCamera() {
    if (remoteSession) {
        // Ya hay una sesión: se vuelve a mostrar el QR (p. ej. para conectar de nuevo)
        if (!remoteSession.dlg) showRemoteQrDialog();
        return;
    }
    await Promise.all([loadSecureLib(PEERJS_LIB), loadSecureLib(QRGEN_LIB)]);

    const code = randomPairCode();
    const peer = new Peer(REMOTE_PEER_PREFIX + code);
    remoteSession = { peer, conn: null, chip: null, dlg: null, count: 0, code };
    const session = remoteSession;

    peer.on('connection', conn => {
        if (remoteSession !== session) { conn.close(); return; }
        if (session.conn && session.conn !== conn) session.conn.close(); // el celular volvió a conectarse
        session.conn = conn;
        conn.on('open', () => {
            if (session.dlg) { closeDialog(session.dlg); session.dlg = null; }
            setRemoteChip(session.count
                ? `Celular conectado · ${session.count} ${session.count === 1 ? 'foto recibida' : 'fotos recibidas'}`
                : 'Celular conectado · sacá la foto desde el celu');
            conn.send({ t: 'hello' });
        });
        conn.on('data', data => receiveRemotePhoto(conn, data));
        conn.on('close', () => {
            if (remoteSession !== session || session.conn !== conn) return;
            session.conn = null;
            setRemoteChip('Esperando al celular…');
        });
    });
    // Si se corta el contacto con el servidor, se reintenta (la conexión con el celu sigue)
    peer.on('disconnected', () => { if (remoteSession === session && !peer.destroyed) peer.reconnect(); });
    peer.on('error', err => {
        if (remoteSession !== session) return;
        console.warn(err);
        if (err.type === 'peer-unavailable') return;
        const msg = peerErrorMessage(err);
        endRemoteSession();
        msgCritical('Foto con celular', msg);
    });

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
    const ready = () => { state.textContent = 'Esperando al celular…'; };
    if (s.peer.open) ready(); else s.peer.once('open', ready);

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
            <button type="button" class="remote-phone-shoot default" disabled>${icon('camera')} Sacar foto</button>
            <p class="remote-phone-count"></p>
            <button type="button" class="remote-phone-exit">Salir</button>
        </div>
    `;
    document.body.appendChild(screen);
    const stateEl = screen.querySelector('.remote-phone-state');
    const shootBtn = screen.querySelector('.remote-phone-shoot');
    const countEl = screen.querySelector('.remote-phone-count');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.hidden = true;
    screen.appendChild(input);

    let peer = null, conn = null, sent = 0;
    const setState = (text, ok = false) => {
        stateEl.textContent = text;
        stateEl.classList.toggle('ok', ok);
    };

    screen.querySelector('.remote-phone-exit').addEventListener('click', () => {
        try { if (peer) peer.destroy(); } catch (_) { /* nada */ }
        history.replaceState(null, '', location.pathname); // la app sigue normal, sin el modo cámara
        screen.remove();
        document.body.classList.remove('remote-phone-mode');
    });

    const connect = () => {
        setState('Conectando con la compu…');
        shootBtn.disabled = true;
        conn = peer.connect(REMOTE_PEER_PREFIX + code, { reliable: true });
        conn.on('open', () => {
            setState('Conectado con la compu.', true);
            shootBtn.disabled = false;
        });
        conn.on('data', data => {
            if (!data) return;
            if (data.t === 'ok') {
                sent++;
                countEl.textContent = `${sent} ${sent === 1 ? 'foto enviada' : 'fotos enviadas'} ✓`;
                setState('¡Listo! La foto ya está en la compu.', true);
                shootBtn.disabled = false;
            } else if (data.t === 'error') {
                setState(data.msg || 'La compu no pudo recibir la foto.');
                shootBtn.disabled = false;
            }
        });
        conn.on('close', () => {
            setState('Se cortó la conexión con la compu. Tocá "Sacar foto" para reintentar.');
            shootBtn.disabled = false;
            conn = null;
        });
    };

    try {
        await loadSecureLib(PEERJS_LIB);
        loadScript(CAMERA_JS_URL).catch(e => console.warn(e)); // la vista previa se baja mientras tanto
        peer = new Peer();
        peer.on('open', connect);
        peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
        peer.on('error', err => {
            console.warn(err);
            setState(peerErrorMessage(err));
            // Sin la compu del otro lado o sin WebRTC no tiene sentido reintentar desde acá
            shootBtn.disabled = err.type === 'peer-unavailable' || err.type === 'browser-incompatible';
        });
    } catch (e) {
        setState(e.message || String(e));
        return;
    }

    shootBtn.addEventListener('click', () => {
        if (!conn || !conn.open) {
            if (peer && peer.open) connect();
            return;
        }
        input.value = '';
        input.click();
    });

    input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        try {
            await loadScript(CAMERA_JS_URL);
            const blob = await scanPhotoDialog(file, { okLabel: 'Enviar a la compu' });
            if (!blob) return;
            if (!conn || !conn.open) {
                setState('Se cortó la conexión con la compu. Tocá "Sacar foto" para reintentar.');
                return;
            }
            shootBtn.disabled = true;
            setState('Enviando la foto…');
            conn.send({ t: 'photo', b: await blob.arrayBuffer() });
        } catch (e) {
            console.error(e);
            shootBtn.disabled = false;
            setState(`No se pudo enviar la foto: ${e.message || e}`);
        }
    });

}
