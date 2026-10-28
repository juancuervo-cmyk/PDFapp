/* App instalable (PWA): registro del service worker y apertura de los PDF que el
   sistema le pasa a la app cuando está elegida como programa para abrir PDF. */

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(e => console.warn('Service worker:', e));
    });
}

// Doble clic en un .pdf (o "Abrir con" > Cuervo.PDF): se abre igual que con el botón Abrir.
// Con un único archivo se conserva su handle, así "Guardar" sobrescribe el mismo archivo.
if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async launchParams => {
        const handles = (launchParams.files || []).filter(h => h.kind === 'file');
        if (!handles.length) return;
        const files = await Promise.all(handles.map(h => h.getFile()));
        await runTask(() => openSelectedFiles(files, handles.length === 1 ? handles[0] : null));
    });
}
