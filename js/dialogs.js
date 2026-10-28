/* =========================================================================
 * dialogs.js
 * Diálogos modales equivalentes a QMessageBox, QInputDialog y a los
 * diálogos propios de B51.py (StampDialog, ExportImageDialog).
 * Todos devuelven Promesas.
 * ========================================================================= */

function isAnyDialogOpen() {
    return !!document.querySelector('dialog[open]');
}

/**
 * Crea un <dialog> modal con título, cuerpo y fila de botones.
 * `onCancel` se invoca con Escape.
 */
function createDialog(title, { className = '' } = {}) {
    const dlg = document.createElement('dialog');
    dlg.className = `qt-dialog ${className}`.trim();

    const titleBar = document.createElement('div');
    titleBar.className = 'dialog-title';
    titleBar.textContent = title;

    const body = document.createElement('div');
    body.className = 'dialog-body';

    const footer = document.createElement('div');
    footer.className = 'dialog-buttons';

    dlg.append(titleBar, body, footer);
    document.body.appendChild(dlg);
    return { dlg, body, footer };
}

function addDialogButton(footer, label, onClick, { isDefault = false } = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    if (isDefault) btn.classList.add('default');
    btn.addEventListener('click', onClick);
    footer.appendChild(btn);
    return btn;
}

function closeDialog(dlg) {
    if (dlg.open) dlg.close();
    dlg.remove();
}

const MESSAGE_ICONS = { info: 'info', warning: 'warning', critical: 'prohibit', question: 'question' };

/**
 * QMessageBox genérico. `buttons` = [{label, value, isDefault}], `escapeValue` = valor al pulsar Escape.
 */
function messageBox(kind, title, text, buttons = [{ label: 'Aceptar', value: 'ok', isDefault: true }], escapeValue = null) {
    return new Promise(resolve => {
        const { dlg, body, footer } = createDialog(title, { className: 'message-box' });
        const row = document.createElement('div');
        row.className = 'message-row';
        const icon = document.createElement('span');
        icon.className = 'message-icon';
        icon.innerHTML = MESSAGE_ICONS[kind] ? window.icon(MESSAGE_ICONS[kind]) : '';
        const msg = document.createElement('div');
        msg.className = 'message-text';
        msg.textContent = text;
        row.append(icon, msg);
        body.appendChild(row);

        let done = false;
        const finish = value => {
            if (done) return;
            done = true;
            closeDialog(dlg);
            resolve(value);
        };

        let defaultBtn = null;
        for (const b of buttons) {
            const btn = addDialogButton(footer, b.label, () => finish(b.value), { isDefault: b.isDefault });
            if (b.isDefault) defaultBtn = btn;
        }
        dlg.addEventListener('cancel', e => {
            e.preventDefault();
            finish(escapeValue !== null ? escapeValue : buttons[buttons.length - 1].value);
        });
        dlg.showModal();
        (defaultBtn || footer.querySelector('button')).focus();
    });
}

const msgInfo = (title, text) => messageBox('info', title, text);
const msgWarning = (title, text) => messageBox('warning', title, text);
const msgCritical = (title, text) => messageBox('critical', title, text);

function msgQuestionYesNo(title, text) {
    return messageBox('question', title, text, [
        { label: 'Sí', value: 'yes', isDefault: true },
        { label: 'No', value: 'no' }
    ], 'no');
}

/** QInputDialog.getText / getMultiLineText. Devuelve el texto o null si se cancela. */
function inputDialog(title, label, { defaultValue = '', multiline = false } = {}) {
    return new Promise(resolve => {
        const { dlg, body, footer } = createDialog(title, { className: 'input-dialog' });
        const lbl = document.createElement('label');
        lbl.className = 'input-label';
        lbl.textContent = label;
        const field = document.createElement(multiline ? 'textarea' : 'input');
        field.className = 'input-field';
        if (!multiline) field.type = 'text';
        else field.rows = 8;
        field.value = defaultValue;
        body.append(lbl, field);

        let done = false;
        const finish = value => {
            if (done) return;
            done = true;
            closeDialog(dlg);
            resolve(value);
        };

        addDialogButton(footer, 'Aceptar', () => finish(field.value), { isDefault: true });
        addDialogButton(footer, 'Cancelar', () => finish(null));
        dlg.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
        field.addEventListener('keydown', e => {
            if (e.key === 'Enter' && (!multiline || e.ctrlKey)) {
                e.preventDefault();
                finish(field.value);
            }
        });
        dlg.showModal();
        field.focus();
        if (!multiline) field.select();
    });
}

/**
 * StampDialog: nombre de la firma, imagen de firma/marca de agua, ancho (50-600, def. 150)
 * y "Aplicar en TODAS las páginas". Devuelve {name, file, width, allPages} o null.
 * `usedNames` = nombres de firmas ya cargadas (no se pueden repetir).
 */
function stampDialog(usedNames = []) {
    return new Promise(resolve => {
        const { dlg, body, footer } = createDialog('Nueva Firma / Marca de Agua', { className: 'stamp-dialog' });
        body.innerHTML = `
            <p><b>Nombre de la firma:</b></p>
            <input type="text" class="input-field stamp-name" maxlength="40" placeholder="Ej.: Juan">
            <p class="dialog-gap"><b>1. Selecciona la imagen de tu firma o marca de agua (PNG/JPG):</b></p>
            <div class="dialog-row">
                <span class="stamp-filename">Ningún archivo seleccionado</span>
                <button type="button" class="stamp-choose">${icon("folder-open")} Buscar Imagen</button>
                <input type="file" class="stamp-file" accept=".png,.jpg,.jpeg,.bmp,image/png,image/jpeg,image/bmp" hidden>
            </div>
            <p class="dialog-gap"><b>2. Configuración de estampa:</b></p>
            <div class="dialog-row">
                <label>Ancho en la página (puntos):</label>
                <input type="number" class="stamp-width" min="50" max="600" value="150">
            </div>
            <label class="dialog-check"><input type="checkbox" class="stamp-all"> Aplicar en TODAS las páginas (Marca de agua global)</label>
        `;
        const fileInput = body.querySelector('.stamp-file');
        const lblName = body.querySelector('.stamp-filename');
        const spinWidth = body.querySelector('.stamp-width');
        const chkAll = body.querySelector('.stamp-all');
        const fieldName = body.querySelector('.stamp-name');
        let chosenFile = null;

        body.querySelector('.stamp-choose').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            if (fileInput.files.length) {
                chosenFile = fileInput.files[0];
                lblName.textContent = chosenFile.name;
            }
        });

        let done = false;
        const finish = value => {
            if (done) return;
            done = true;
            closeDialog(dlg);
            resolve(value);
        };

        addDialogButton(footer, 'Aceptar', async () => {
            const name = fieldName.value.trim();
            if (!name) {
                await msgWarning('Aviso', 'Por favor, escribe un nombre para la firma.');
                fieldName.focus();
                return;
            }
            if (usedNames.some(n => n.toLowerCase() === name.toLowerCase())) {
                await msgWarning('Aviso', `Ya existe una firma llamada "${name}". Elige otro nombre.`);
                fieldName.focus();
                return;
            }
            if (!chosenFile) {
                await msgWarning('Aviso', 'Por favor, selecciona un archivo de imagen válido.');
                return;
            }
            finish({ name, file: chosenFile, width: clampInt(spinWidth.value, 50, 600, 150), allPages: chkAll.checked });
        }, { isDefault: true });
        addDialogButton(footer, 'Cancelar', () => finish(null));
        dlg.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
        dlg.showModal();
        fieldName.focus();
    });
}

/**
 * ExportImageDialog: formato PNG/JPG, página actual o todas, DPI (72-600, def. 150).
 * Devuelve {format, allPages, dpi} o null.
 */
function exportImageDialog(totalPages, currentPage) {
    return new Promise(resolve => {
        const { dlg, body, footer } = createDialog('Exportar Páginas a Imagen', { className: 'export-dialog' });
        body.innerHTML = `
            <p><b>1. Formato de salida:</b></p>
            <div class="dialog-row">
                <label><input type="radio" name="exp-format" value="png" checked> PNG (Alta calidad / Transparencia)</label>
                <label><input type="radio" name="exp-format" value="jpg"> JPG (Archivo más liviano)</label>
            </div>
            <p class="dialog-gap"><b>2. Rango de páginas a exportar:</b></p>
            <div class="dialog-col">
                <label><input type="radio" name="exp-range" value="current" checked> Solo la página actual (${currentPage + 1})</label>
                <label><input type="radio" name="exp-range" value="all"> Todas las páginas (1 a ${totalPages})</label>
            </div>
            <div class="dialog-row dialog-gap">
                <label>Calidad / Resolución (DPI):</label>
                <input type="number" class="exp-dpi" min="72" max="600" value="150">
            </div>
        `;
        let done = false;
        const finish = value => {
            if (done) return;
            done = true;
            closeDialog(dlg);
            resolve(value);
        };
        addDialogButton(footer, 'Aceptar', () => finish({
            format: body.querySelector('input[name="exp-format"]:checked').value,
            allPages: body.querySelector('input[name="exp-range"]:checked').value === 'all',
            dpi: clampInt(body.querySelector('.exp-dpi').value, 72, 600, 150)
        }), { isDefault: true });
        addDialogButton(footer, 'Cancelar', () => finish(null));
        dlg.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
        dlg.showModal();
    });
}

function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}
