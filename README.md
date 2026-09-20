# TerraUnlock

Mapa mundial tipo "niebla de guerra" de videojuego que se revela con tu posición GPS real. Desbloquea países, comunidades autónomas, provincias y cimas según los pises, con progreso y % conquistado por nivel.

**Demo:** https://davidburgoscarpeno.github.io/TerraUnlock/

## Estado (MVP v0.1)

- Mapa vectorial propio en canvas (Web Mercator, sin librerías de mapas).
- Niebla revelada en círculos de ~1,3 km alrededor de cada punto visitado.
- Desbloqueo automático: 177 países (Natural Earth), 19 CCAA y 52 provincias (España), 3.400+ cimas (Geonames ES + Wikidata ≥4.500 m) conquistables a <250 m.
- Persistencia local (localStorage) + exportar/importar progreso.
- Modo prueba para simular posición tocando el mapa.
- Niebla translúcida: el mapa se ve atenuado en lo no descubierto y se ilumina al revelarlo.
- Screen Wake Lock mientras el GPS está activo: la pantalla no se apaga con la app abierta. Ojo: los navegadores suspenden la geolocalización con la app en segundo plano; el seguimiento en background real llega con el wrapper nativo (Capacitor + plugin de background geolocation) en la fase de stores.

## Arquitectura

- **Frontend:** React 18 + TypeScript + Vite. Sin dependencias de mapas: motor propio en canvas.
- **Datos:** GeoJSON simplificado (Douglas-Peucker) empaquetado en src/data/ como módulos TS. Fuentes: Natural Earth (países), click_that_hood (CCAA/provincias ES), Geonames (cimas ES), Wikidata (cimas mundo).
- **Despliegue:** GitHub Pages (rama gh-pages, build con npm run build, base /TerraUnlock/).
- **Modelo multiusuario preparado:** todo el progreso cuelga de un perfil (local en el MVP) para migrar a cuentas en fase 2.

## Roadmap

- **Importación de rutas (siguiente):** importar tracks GPX y sincronizar con Strava/Garmin para revelar y desbloquear lo ya recorrido, incluso retroactivamente. Es la solución seria al GPS en segundo plano mientras llega la app nativa.
- **Fase 2 (social):** cuentas de usuario y capa social (rankings globales, piques con amigos, comparar % conquistado) con backend ligero (Supabase).
- **Fase 3 (stores):** apps nativas en App Store / Google Play empaquetando esta base web con Capacitor (sin reescritura), incluyendo plugin de background geolocation para desbloquear con la app en segundo plano.
- Mejoras de datos: cobertura completa de cimas mundiales (Geonames por países), fronteras de mayor resolución, service worker offline (PWA instalable completa).

## Desarrollo

npm install
npm run dev
npm run build   # genera dist/ para gh-pages
