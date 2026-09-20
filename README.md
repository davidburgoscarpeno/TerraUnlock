# TerraUnlock

Mapa mundial tipo "niebla de guerra" de videojuego que se revela con tu posición GPS real. Desbloquea países, comunidades autónomas, provincias y cimas según los pises, con progreso y % conquistado por nivel.

**Demo:** https://davidburgoscarpeno.github.io/TerraUnlock/

## Estado (MVP v0.1)

- Mapa vectorial propio en canvas (Web Mercator, sin librerías de mapas).
- Niebla revelada en círculos de ~1,3 km alrededor de cada punto visitado.
- Desbloqueo automático: 177 países (Natural Earth), 19 CCAA y 52 provincias (España), 3.400+ cimas (Geonames ES + Wikidata ≥4.500 m) conquistables a <250 m.
- Persistencia local (localStorage) + exportar/importar progreso.
- Modo prueba para simular posición tocando el mapa.

## Arquitectura

- **Frontend:** React 18 + TypeScript + Vite. Sin dependencias de mapas: motor propio en canvas.
- **Datos:** GeoJSON simplificado (Douglas-Peucker) empaquetado en src/data/ como módulos TS. Fuentes: Natural Earth (países), click_that_hood (CCAA/provincias ES), Geonames (cimas ES), Wikidata (cimas mundo).
- **Despliegue:** GitHub Pages (rama gh-pages, build con npm run build, base /TerraUnlock/).
- **Modelo multiusuario preparado:** todo el progreso cuelga de un perfil (local en el MVP) para migrar a cuentas en fase 2.

## Roadmap

- **Fase 2:** cuentas de usuario y capa social (rankings globales, piques con amigos, comparar % conquistado) con backend ligero (Supabase).
- **Fase 3:** apps nativas en App Store / Google Play empaquetando esta base web con Capacitor (sin reescritura).
- Mejoras de datos: cobertura completa de cimas mundiales (Geonames por países), fronteras de mayor resolución, service worker offline (PWA instalable completa).

## Desarrollo

npm install
npm run dev
npm run build   # genera dist/ para gh-pages
