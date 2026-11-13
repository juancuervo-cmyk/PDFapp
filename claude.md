el archivo en la carpeta C:\Users\agost\OneDrive\Escritorio\prueba pa no pyton\primera referencia es la primera version en pyton del programa que estamso trabajando. lo pasamos a formato web para más comodidad. ahora se trabaja en html, css y js.

este archivo no lo vas a modificar, solo se usó a modo de referencia inicial.

todos los cambios ahora se van a trabajar sobre el html, css y js y no vas a actualizar el py

PREMISA PRINCIPAL — OPTIMIZACIÓN:
- es importantísimo que todo el programa de cuervo.pdf esté completamente optimizado. lo que lo diferencia del resto es su rapidez de carga y de respuesta, por lo que es indispensable que esto se mantenga en cada cambio.
- a la vez queremos que sea más completo que otros. por eso, si te pedimos algo que ves que va a aumentar significativamente el peso o la carga general del programa (librerías nuevas, archivos pesados, procesos lentos, más requests, etc.), AVISANOS antes de implementarlo para que tomemos esa decisión con seguridad.
- si no impacta significativamente, buscá siempre la manera más optimizada de aplicar lo que te pedimos.

LECTOR DE QR — NO TOCAR:
- cuando se hagan cambios, no toques la función del lector de QR (Validar QR: toggleQrTool, readQrInRegion, validateQrInRect, la carga de zxing/jsQR y el modo 'qr' en los eventos del canvas). suele pasar que al pedir otros cambios el QR deja de funcionar en ciertos momentos.
- si un cambio pedido obliga a tocar algo que el QR usa (setMode, eventos del overlay, loadScript, etc.), avisá antes y verificá después que Validar QR siga funcionando.

no hagas cambios sobre funcionalidades que no sean las que te pedí explicitamente. si algo no es compatible con el resto de las funciones me avisas y yo te digo cómo seguir.

para iconos utilizaremos siempre los cargados en C:\Users\agost\OneDrive\Escritorio\prueba pa no pyton\phosphor-icons (1)\SVGs\regular

las animaciones deberás realizarlas con la librería GSAP

LIBRERÍAS EXTERNAS — SEGURIDAD:
- antes de proponer o agregar una librería nueva, verificá que sea segura: repositorio público y mantenido (no archivado, con actividad reciente), licencia abierta, ampliamente usada y sin vulnerabilidades conocidas. pasame ese resultado y AVISAME antes de implementarla.
- cargala sólo desde CDNs confiables (cdnjs.cloudflare.com o cdn.jsdelivr.net), con la versión exacta fijada (ej. @1.5.5, nunca @latest ni sólo el número mayor como @5).
- agregale el control de integridad (atributo integrity con su hash sha384, "SRI") para que el navegador no la ejecute si el archivo fue alterado.
- si la librería usa un servicio o servidor externo de terceros, avisame qué datos pasan por ahí.
- siempre que se pueda, cargala sólo cuando se usa la función (no en la carga inicial de la app).

repositorio de github: https://github.com/juancuervo-cmyk/PDFapp (rama main)

dominio en vercel: https://pdf-app-rose.vercel.app/

control de versiones:
- nunca hagas push ni pull sin mi autorización.
- al iniciar un nuevo chat siempre revisa que todos los archivos concuerden con el repo (git fetch y comparar con origin/main). si hay diferencias o hace falta hacer pull, AVISAME y yo te digo si sí o si no. haz el análisis primero: si los archivos son los mismos y no hay nada nuevo para traer, no me preguntes por el pull, simplemente sigue.
- también revisa si la colaboradora agostina realizó cambios en main. siempre preserva los cambios tanto míos como de ella, para que todo lo que se suba a main no pise ni pierda nada de nadie.

nota para mi papá: 
- Sonnet 5.5 para cambios chiquitos y preguntas
- TOP Opus 5.5 para funciones y cambios grandes o difíciles