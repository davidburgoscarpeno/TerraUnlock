# TerraUnlock

Mapa mundial tipo "niebla de guerra" de videojuego que se revela con tu posición GPS real. Desbloquea países, comunidades autónomas, provincias y cimas según los pises, con progreso y % conquistado por nivel.

**Demo:** https://davidburgoscarpeno.github.io/TerraUnlock/

## Estado (v0.6)

- Mapa vectorial propio en canvas (Web Mercator, sin librerías de mapas).
- Niebla revelada en círculos de ~1,3 km alrededor de cada punto visitado.
- Desbloqueo automático: 177 países (Natural Earth), 19 CCAA y 52 provincias (España), ~57.000 cimas en todo el mundo (Geonames por pais, top 400 por altitud, mas el curado de 2.169 de España) conquistables a <1 km.
- Todas las cimas se dibujan en el mapa (la mas alta de cada zona si se solapan); con zoom cercano aparece nombre y altitud. Al tocar una cima se abre su ficha: altitud, si esta conquistada y enlace a sus rutas en Wikiloc.
- PWA instalable (manifest + iconos) y usable offline: service worker con precache del app shell y cache de tiles de satelite ya vistos (tope ~1.500, se reciclan).
- Persistencia local (localStorage) + exportar/importar progreso.
- Modo prueba para simular posición tocando el mapa.
- Niebla translúcida: el mapa se ve atenuado en lo no descubierto y se ilumina al revelarlo.
- Importacion de rutas GPX: sube un .gpx (Strava, Garmin, Wikiloc, cualquier app), preview del track sobre el mapa con lo que desbloqueara, y se aplica al progreso como si lo hubieras caminado.
- Screen Wake Lock mientras el GPS está activo: la pantalla no se apaga con la app abierta. Ojo: los navegadores suspenden la geolocalización con la app en segundo plano; el seguimiento en background real llega con el wrapper nativo (Capacitor + plugin de background geolocation) en la fase de stores.

## Arquitectura

- **Frontend:** React 18 + TypeScript + Vite. Motor de mapa propio en canvas, sin dependencias de mapas.
- **Mapa base:** tiles de satelite Esri World Imagery (World Imagery MapServer), gratuitos y sin API key, con atribucion visible en la app ("Esri, Maxar, Earthstar Geographics"). Encima van la niebla translucida y la iluminacion de lo conquistado. Alternativa documentada si cambian sus terminos: OpenTopoMap (CC-BY-SA).
- **Datos:** GeoJSON simplificado (Douglas-Peucker) empaquetado en src/data/ como módulos TS. Fuentes: Natural Earth (países), click_that_hood (CCAA/provincias ES), Geonames (cimas). Las cimas del mundo (54.752, 221 paises, feature class T: PK/MT/MTS, top 400 por pais por altitud) se descargan perezoso desde public/data/peaks-world.json y las cachea el service worker.
- **PWA:** manifest.webmanifest + iconos generados (scripts/gen-icons.mjs) + service worker generado en build (scripts/gen-sw.mjs): precache del shell, cache-first para tiles Esri con recorte, navegacion con fallback offline al shell.
- **Despliegue:** GitHub Pages (rama gh-pages, build con npm run build, base /TerraUnlock/).
- **Modelo multiusuario preparado:** todo el progreso cuelga de un perfil (local en el MVP) para migrar a cuentas en fase 2.

## Roadmap

- **Sync Strava/Garmin (siguiente):** conexion OAuth con Strava y Garmin para importar actividades automaticamente (la importacion GPX ya esta disponible; Strava exige registrar una app de API con la cuenta de David).
- **Fase 2 (social):** cuentas de usuario y capa social (rankings globales, piques con amigos, comparar % conquistado) con backend ligero (Supabase).
- **Fase 3 (stores):** apps nativas en App Store / Google Play empaquetando esta base web con Capacitor (sin reescritura), incluyendo plugin de background geolocation para desbloquear con la app en segundo plano.
- **Rutas Wikiloc por cima (decision documentada):** al tocar una cima, su ficha enlaza a la busqueda de rutas de Wikiloc para esa cima. Mecanismos estudiados: (1) API/partner de Wikiloc: existe un programa para marcas y federaciones, pero exige acuerdo comercial y no da acceso self-service; (2) embeds iframe: Wikiloc los ofrece oficialmente desde el boton de compartir de CADA ruta, pero hay que conocer el ID de la ruta concreta (no sirve para "rutas de esta cima" sin base de datos propia de IDs); (3) enlaces de busqueda: permitidos (enlazar no viola sus terminos; el scraping de resultados SI lo violaria). Opcion elegida: enlaces de busqueda por nombre de cima (es.wikiloc.com/rutas?q=...). Limite: la comparativa "cual es la ruta mas facil" (distancia/desnivel/dificultad) se hace en la propia pagina de Wikiloc; para traer esos datos dentro de TerraUnlock haria falta el programa partner o una seleccion editorial de rutas con sus IDs (embebibles via iframe oficial).

## Desarrollo

npm install
npm run dev
npm run build   # genera dist/ para gh-pages (incluye sw.js via scripts/gen-sw.mjs)
node scripts/gen-icons.mjs   # regenera los iconos PWA en public/icons/
