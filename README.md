# TerraUnlock

Mapa mundial tipo "niebla de guerra" de videojuego que se revela con tu posición GPS real. Desbloquea países, comunidades autónomas, provincias y cimas según los pises, con progreso y % conquistado por nivel.

**Demo:** https://davidburgoscarpeno.github.io/TerraUnlock/

## Estado (v1.23)

- "Este mes" en Progreso: distancia, aventuras, territorios nuevos y cimas del mes actual, cada uno con la cifra del mes pasado al lado. Se calcula desde las aventuras guardadas.

## Estado (v1.22)

- La tarjeta PNG de aventura dibuja el mini-mapa de la ruta: polyline teal con punto de inicio (teal) y fin (amarillo), encajada automaticamente. Si ademas hay perfil de elevacion, la tarjeta crece para enseñar los dos.

## Estado (v1.21.2)

- El mejor km/milla ahora sale tambien en aventuras con traza muy diezmada: el tramo minimo baja de 0,98 a 0,5 unidades y el ritmo se escala por la distancia real del tramo (antes muchas ventanas quedaban descartadas y no salia "Mejor km").

## Estado (v1.21.1)

- Guarda de cordura en el ritmo: si el ritmo medio sale por debajo de 15 s/km (~240 km/h, datos corruptos o sinteticos), no se muestra ritmo en vez de enseñar un 0:00/km absurdo.

## Estado (v1.21)

- La tarjeta PNG de aventura muestra el ritmo medio y el mejor km (o milla, segun unidades) cuando la aventura tiene timestamps reales, igual que el modal y la lista.

## Estado (v1.20.1)

- Porcentajes y el eje de distancia del perfil de elevacion usan el separador decimal del idioma (coma en espanol, punto en ingles).

## Estado (v1.20)

- Internacionalizacion: la app habla espanol e ingles. Selector en Ajustes > Idioma; por defecto usa el idioma del navegador (espanol si empieza por "es", ingles en cualquier otro caso). La eleccion se guarda en este dispositivo.
- Cubre toda la interfaz: navegacion, mapa, objetivo semanal, banners y toasts, importacion, fichas, progreso, logros, ajustes, bienvenida, tarjetas PNG para compartir, perfil de elevacion y terreno 3D.
- Estructura preparada para mas idiomas: cada idioma es un diccionario en src/i18n.ts y una entrada en LANGS; anadir uno no toca componentes.
- Los nombres de territorios y cimas siguen en espanol (son datos de catalogo), igual que los metadatos del GPX exportado.

## Estado (v1.19)

- Renombrar aventuras (boton "Renombrar" al desplegarla). El nombre sale en la lista, en la tarjeta PNG y como nombre del track en el GPX exportado. Sin nombre, todo sigue mostrando la fecha como antes.

## Estado (v1.18)

- Borrar una aventura de la lista (boton "Borrar" al desplegarla, con confirmacion). Solo quita la aventura: el territorio revelado y los desbloqueos se quedan.

## Estado (v1.17)

- Ritmo medio y mejor km (o milla, segun unidades) en aventuras con timestamps reales: se ven en el modal al terminar y al desplegar la aventura en la lista.

## Estado (v1.16)

- Las aventuras grabadas en vivo guardan el timestamp real de cada punto GPS. El GPX exportado lleva el ritmo verdadero (no interpolado). Aventuras antiguas e importadas sin tiempos siguen exportando con tiempos interpolados.

## Estado (v1.15)

- Racha de objetivos semanales: cada semana seguida cumpliendo el objetivo suma; se muestra junto al objetivo ("racha: N semanas") y hay logros nuevos a las 2, 4, 8 y 12 semanas seguidas. La racha entra en el JSON de respaldo (exportar/importar).

## Estado (v1.14)

- Importar un GPX suelto como aventura: boton "Importar GPX como aventura" en Progreso > Aventuras. Revela la niebla del recorrido, desbloquea territorios y cimas, y crea la aventura en la lista con su track, perfil de elevacion, tarjeta para compartir y exportacion. Usa los tiempos del propio GPX; si no los tiene, fecha de importacion.

## Estado (v1.13)

- Exportar cualquier aventura a GPX 1.1 (boton "Exportar GPX" al terminar una aventura y en cada aventura desplegada). Incluye elevacion real del terreno cuando hay perfil calculado; compatible con Strava, Garmin Connect, Wikiloc y Google Earth. Nota: el track no guarda timestamps por punto, asi que los tiempos del GPX se interpolan entre el inicio y el fin de la aventura.

## Estado (v1.12)

- Tarjeta PNG de aventura para compartir: avatar y nombre, fecha, km, puntos, duracion, desnivel, el grafico del perfil de elevacion y los desbloqueos (territorios y cimas). Boton "Compartir aventura" en el resumen al terminar y en cada aventura desplegada de la lista.

## Estado (v1.11)

- Perfil de elevacion de aventuras: al terminar una aventura, su resumen muestra el grafico altitud-distancia del recorrido, con subida y bajada acumuladas y cotas min/max. En la lista de Aventuras, toca una para desplegar su perfil. Solo aventuras empezadas desde esta version (las antiguas no guardan su trazado). Elevacion de AWS Terrain Tiles (Terrarium), muestreo bilineal; el perfil calculado se guarda en el dispositivo y funciona offline.

## Estado (v1.10)

- Tarjeta semanal para compartir (PNG): lo conquistado esta semana (territorios y cimas, con nombres), el rango de la semana y el estado del objetivo semanal. Boton "Compartir mi semana" en Progreso y en la tarjeta del objetivo en el Mapa. Usa la hoja de compartir del sistema si puede y si no, descarga el PNG.

## Estado (v1.9)

- Objetivo semanal automatico: desbloquea 3 territorios nuevos o conquista 1 cima antes del lunes. Tarjeta en el Mapa con barras de progreso y dias restantes; al cumplirlo, celebra con el modal de logros y la tarjeta queda marcada. Se reinicia solo cada lunes (semana ISO) y el progreso se guarda en el dispositivo.

## Estado (v1.8)

- Estadisticas por territorio: la ficha de region ahora desglosa su contenido (una comunidad lista sus provincias, una provincia o pais lista sus cimas sin conquistar con acceso directo, Espana lista sus comunidades), cada una con % revelado y acceso para centrarla en el mapa. En Progreso, nuevo ranking "Comunidades mas dominadas" (top 8 por % de superficie revelada) con boton para abrirlas.

## Estado (v1.7)

- Ficha de cima con terreno: vista 3D giratoria del relieve (arrastra para rotar) y mapa de curvas de nivel con sombreado hipsometrico, escala y norte. Elevacion de AWS Terrain Tiles (Mapzen Terrarium, datos abiertos, sin API key), recorte de ~8 km alrededor de la cima. Se carga bajo demanda y el SW la cachea para uso offline posterior.

## Estado (v1.6)

- "Te falta cerca" en el Mapa: hasta 5 territorios sin conquistar en 150 km (provincias y comunidades en Espana, paises fuera), con distancia aproximada a su frontera y direccion (N, NE...). Toca una fila para centrar el mapa en ella. Usa tu posicion GPS o, sin GPS, el centro del mapa. Si no queda nada en 150 km, lo dice ("Zona dominada").

## Estado (v1.5)

- Perfil con foto: "Subir foto" en Ajustes la recorta a cuadrado y la guarda a 256 px en el dispositivo (unos 5 KB); sale en el saludo del header, en Ajustes y en la tarjeta de compartir (avatar + "El mundo de ..."). Sin foto, circulo con la inicial. Boton "Quitar".
- Export/import incluye el perfil (nombre + avatar): la copia completa restaura tambien la cara.

## Estado (v1.4)

- Aviso celebratorio al entrar en territorio nuevo: al desbloquear una provincia, comunidad o pais aparece un banner sobre el mapa ("Provincia nueva: Granada - ya llevas 5 de 52") con boton de compartir, cierre automatico a los 8 s, vibracion en movil y cola si saltan varios a la vez. En importaciones (GPX/FIT/ZIP) sale un unico aviso resumen en vez de una celebracion por cada territorio. No es pantalla completa ni se repite al recargar.

## Estado (v1.3)

- "Rutas en Wikiloc" de cada cima abre el mapa de rutas de Wikiloc centrado en la cima (bbox de unos 3 km): salen las rutas que pasan por ahi, ordenadas por relevancia, en vez de una busqueda generica por nombre (v1.3.1).

- Modo aventura: boton "Empezar aventura" en el Mapa; panel en vivo con distancia, tiempo y desbloqueos de la sesion (paises, CCAA, provincias, cimas); al terminar, resumen con boton de compartir (tarjeta PNG) y la aventura queda guardada en Progreso. La aventura en curso se persiste y sobrevive a recargas.
- Rachas: dias seguidos revelando territorio (al menos un punto GPS). Badge "Racha: X dias" en el header (desde 2), fila de racha en Progreso y 2 logros nuevos: "En racha" (3 dias) y "Semana de conquista" (7 dias).
- Exportar/importar completo: el archivo pasa a v2 e incluye progreso, logros, racha y aventuras; las exportaciones v1 se siguen importando.
- Sistema de logros (18 en 5 categorias: superficie, paises, territorio ES, cimas, puntos GPS y rachas): celebracion a pantalla completa al desbloquear con boton de compartir (tarjeta PNG), y seccion Logros en Progreso con fecha de desbloqueo y pistas. En la primera ejecucion siembra en silencio lo ya conseguido; solo celebra logros nuevos.
- HUD del mapa: barra de escala que se adapta al zoom (km/mi segun ajustes) y badge con la cima conquistable mas cercana (<25 km del centro visible).

- Buscador de cimas en la pestana Cimas: filtra las 59.053 por nombre (ignora tildes), ordena por altitud y "Ver" centra el mapa en la cima con su ficha abierta.
- Cimas cercanas: con tu posicion, lista las cimas conquistables a menos de 100 km ordenadas por distancia, con altitud y acceso al mapa.
- Compartir progreso sin cuentas: boton en Progreso que genera una tarjeta PNG (mapa mundi con lo revelado + stats) y la comparte con Web Share API en movil o la descarga en desktop.
- Toasts globales: los avisos se ven en cualquier pestana, no solo en Mapa.

- Navegacion adaptada a desktop: barra lateral con marca en pantallas anchas (>=900 px), barra inferior en movil.
- Ficha de region al tocar el mapa: nombre de pais/comunidad/provincia en el punto tocado, si esta conquistada y % revelado dentro de ella (muestreo del area de la region).
- Barras de progreso por nivel en la pestana Progreso.

- App shell con estructura de app: barra de navegacion inferior fija con 4 pestanas (Mapa, Progreso, Cimas, Ajustes), con soporte de safe-area para moviles con notch.
- Pantalla de bienvenida en el primer arranque (que es TerraUnlock, como se revela el mapa, que datos se guardan) y re-mostrable desde Ajustes.
- Pestana Progreso: stats por nivel con % conquistado (paises, CCAA, provincias, cimas) y territorio revelado.
- Pestana Cimas: contador global y lista completa de cimas conquistadas con altitud.
- Pestana Ajustes (todo funcional): Perfil (avatar con inicial, nombre visible editable que saluda en el header, estado "sin cuenta" y boton "Crear cuenta (proximamente)" ya preparado para la fase 2), Mapa (oscuridad de la niebla 0.4-0.9, etiquetas de cimas on/off, re-mostrar bienvenida), Unidades (km/mi aplicadas a toda la app), Datos (exportar/importar progreso, importar rutas, reiniciar).
- Preferencias persistentes en localStorage (terraunlock.prefs.v1): nombre, niebla, etiquetas, unidades, bienvenida vista.
- Mapa vectorial propio en canvas (Web Mercator, sin librerías de mapas).
- Niebla revelada en círculos de ~1,3 km alrededor de cada punto visitado.
- Desbloqueo automático: 177 países (Natural Earth), 19 CCAA y 52 provincias (España), ~58.000 cimas en todo el mundo (Geonames por pais, top 400 por altitud, mas el curado de 2.169 de España) conquistables a <1 km.
- Todas las cimas se dibujan en el mapa (la mas alta de cada zona si se solapan); con zoom cercano aparece nombre y altitud. Al tocar una cima se abre su ficha: altitud, si esta conquistada y enlace a sus rutas en Wikiloc.
- PWA instalable (manifest + iconos) y usable offline: service worker con precache del app shell y cache de tiles de satelite ya vistos (tope ~1.500, se reciclan).
- Persistencia local (localStorage) + exportar/importar progreso.
- Modo prueba para simular posición tocando el mapa.
- Niebla translúcida: el mapa se ve atenuado en lo no descubierto y se ilumina al revelarlo.
- Importacion de rutas en lote: sube uno o varios .gpx/.fit (o .gpx.gz/.fit.gz), o el ZIP completo de exportacion de Strava (strava.com/athlete/delete_your_account, seccion de descarga) o la exportacion GDPR de Garmin Connect. Se previsualizan todos los tracks sobre el mapa con lo que desbloquearan y se aplican de golpe, como si los hubieras caminado. FIT soportado (parser fit-file-parser v5); GPX via DOMParser; ZIP/GZ via fflate (todo local, nada sale del dispositivo).
- Screen Wake Lock mientras el GPS está activo: la pantalla no se apaga con la app abierta. Ojo: los navegadores suspenden la geolocalización con la app en segundo plano; el seguimiento en background real llega con el wrapper nativo (Capacitor + plugin de background geolocation) en la fase de stores.

## Arquitectura

- **Frontend:** React 18 + TypeScript + Vite. Motor de mapa propio en canvas, sin dependencias de mapas.
- **Mapa base:** tiles de satelite Esri World Imagery (World Imagery MapServer), gratuitos y sin API key, con atribucion visible en la app ("Esri, Maxar, Earthstar Geographics"). Encima van la niebla translucida y la iluminacion de lo conquistado. Alternativa documentada si cambian sus terminos: OpenTopoMap (CC-BY-SA).
- **Datos:** GeoJSON simplificado (Douglas-Peucker) empaquetado en src/data/ como módulos TS. Fuentes: Natural Earth (países), click_that_hood (CCAA/provincias ES), Geonames (cimas). Las cimas del mundo (55.641: 221 paises, top 400 por pais por altitud, mas 889 cimas extra de España del dump completo Geonames, deduplicadas a <150 m del curado) se descargan perezoso desde public/data/peaks-world.json y las cachea el service worker.
- **PWA:** manifest.webmanifest + iconos generados (scripts/gen-icons.mjs) + service worker generado en build (scripts/gen-sw.mjs): precache del shell, cache-first para tiles Esri con recorte, navegacion con fallback offline al shell.
- **Despliegue:** GitHub Pages (rama gh-pages, build con npm run build, base /TerraUnlock/).
- **Modelo multiusuario preparado:** todo el progreso cuelga de un perfil (local en el MVP) para migrar a cuentas en fase 2.

## Roadmap

- **Sync Strava (aparcada):** desde junio 2026 Strava exige suscripcion de pago (Strava subscription) para crear apps de desarrollador, asi que el OAuth queda aparcado hasta que David tenga Premium. Alternativa ya implementada: exportacion completa del historial (ZIP) importable en lote.
- **Sync Garmin (viabilidad estudiada, pendiente de decision):** el Garmin Connect Developer Program no cobra licencia por el acceso, pero esta orientado a uso empresarial: hay que rellenar el formulario de acceso (revision en ~2 dias laborables), justificar el caso de uso como negocio y hacer una llamada de integracion; las APIs son server-to-server con OAuth 2.0 (Health/Activity API), lo que ademas exigiria backend propio. Friccion alta para un proyecto personal. Alternativa sin friccion ya implementada: la exportacion de datos de Garmin Connect (GDPR) contiene los .FIT de todas las actividades y se importa en lote tal cual.
- **Fase 2 (social):** cuentas de usuario y capa social (rankings globales, piques con amigos, comparar % conquistado) con backend ligero (Supabase).
- **Fase 3 (stores):** apps nativas en App Store / Google Play empaquetando esta base web con Capacitor (sin reescritura). Scaffolding ya preparado: capacitor.config.ts (appId com.terraunlock.app, webDir dist) + scripts npm cap:sync / cap:add:android / cap:add:ios. Pendiente: cuentas de store de David (Apple 99 USD/ano, Google 25 USD unico), generar plataformas nativas y plugin de background geolocation.
- **Rutas Wikiloc por cima (decision documentada):** al tocar una cima, su ficha enlaza a la busqueda de rutas de Wikiloc para esa cima. Mecanismos estudiados: (1) API/partner de Wikiloc: existe un programa para marcas y federaciones, pero exige acuerdo comercial y no da acceso self-service; (2) embeds iframe: Wikiloc los ofrece oficialmente desde el boton de compartir de CADA ruta, pero hay que conocer el ID de la ruta concreta (no sirve para "rutas de esta cima" sin base de datos propia de IDs); (3) enlaces de busqueda: permitidos (enlazar no viola sus terminos; el scraping de resultados SI lo violaria). Opcion elegida: enlaces de busqueda por nombre de cima (es.wikiloc.com/rutas?q=...). Limite: la comparativa "cual es la ruta mas facil" (distancia/desnivel/dificultad) se hace en la propia pagina de Wikiloc; para traer esos datos dentro de TerraUnlock haria falta el programa partner o una seleccion editorial de rutas con sus IDs (embebibles via iframe oficial).

## Desarrollo

npm install
npm run dev
npm run build   # genera dist/ para gh-pages (incluye sw.js via scripts/gen-sw.mjs)
node scripts/gen-icons.mjs   # regenera los iconos PWA en public/icons/
