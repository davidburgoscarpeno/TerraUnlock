import React, { useEffect, useMemo, useRef, useState } from 'react';
import './style.css';
import { COUNTRIES } from './data/countries';
import type { Region } from './data/countries';
import { CCAA } from './data/ccaa';
import { PROV } from './data/prov';
import { PEAKS_ES } from './data/peaks_es';
import type { Peak } from './data/peaks_es';
import { PEAKS_WORLD } from './data/peaks_world';
import TerrainCard from './Terrain';
import ElevChart from './ElevChart';
import PaceChart from './PaceChart';
import { computeProfile, drawProfile } from './adventureProfile';
import { adventureToGpx, gpxFilename } from './gpxExport';
import { t, setLang, detectLang, dateLocale, monthName, dec, compass8, LANGS, type Lang } from './i18n';
import { APP_VERSION } from './version';
import type { Adventure, AdventureProfile } from './types';
import TrackThumb from './TrackThumb';
import { beginStravaConnect, completeStravaConnect, fetchStravaTracks, loadStrava, saveStrava, type StravaConn } from './strava';

const CELL = 0.01; // grados, ~1,1 km de lado
const TILE_URL = (tz: number, j: number, i: number) => 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + tz + '/' + j + '/' + i;
const TILE_MAXZ = 17;
const REVEAL_M = 1300;
const PEAK_M = 250;
const STORE_KEY = 'terraunlock.progress.v1';
const VIEW_KEY = 'terraunlock.view.v1';
const SPAIN_BBOX = [-9.7, 35.0, 4.5, 44.2];
const BASE_PEAKS: Peak[] = [...PEAKS_ES, ...PEAKS_WORLD];

// Modelo pensado para multiusuario en fase 2: todo el progreso cuelga de un perfil.
interface Progress { cells: string[]; points: [number, number][]; countries: string[]; ccaa: string[]; prov: string[]; peaks: string[]; }
const EMPTY: Progress = { cells: [], points: [], countries: [], ccaa: [], prov: [], peaks: [] };

function loadProgress(): Progress {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) { const p = JSON.parse(raw); return { ...EMPTY, ...p }; }
    } catch { /* almacenamiento no disponible */ }
    return { ...EMPTY };
}
function saveProgress(p: Progress) { try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch { /* sin espacio */ } }

function project(lon: number, lat: number, z: number) {
    const W = 256 * Math.pow(2, z);
    const c = Math.max(-85, Math.min(85, lat));
    const s = Math.sin(c * Math.PI / 180);
    return { x: (lon + 180) / 360 * W, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * W };
}
function unproject(x: number, y: number, z: number) {
    const W = 256 * Math.pow(2, z);
    const lon = x / W * 360 - 180;
    const n = Math.PI - 2 * Math.PI * y / W;
    const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lon, lat };
}
function distM(a: [number, number], b: [number, number]) {
    const m = (a[0] + b[0]) / 2 * Math.PI / 180;
    return Math.hypot((a[1] - b[1]) * 111320 * Math.cos(m), (a[0] - b[0]) * 110540);
}
function pip(lon: number, lat: number, rings: number[][]) {
    let inside = false;
    for (const r of rings) {
        for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
            const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
            if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
        }
    }
    return inside;
}
function regionAt(regions: Region[], lon: number, lat: number) {
    for (const rg of regions) {
        const b = rg.b;
        if (lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3] && pip(lon, lat, rg.r)) return rg.n;
    }
    return null;
}
type TerrBanner = { title: string; sub: string };

function peakId(p: Peak) { return p[0] + '|' + p[1] + '|' + p[2]; }

// Provincia -> comunidad, por el centroide de la provincia dentro del poligono de la comunidad.
const provCcaaCache = new Map<string, string | null>();
function provToCcaa(pv: Region): string | null {
    let a = provCcaaCache.get(pv.n);
    if (a === undefined) {
        a = null;
        for (const c of CCAA) {
            const b = c.b;
            if (pv.c[0] >= b[0] && pv.c[0] <= b[2] && pv.c[1] >= b[1] && pv.c[1] <= b[3] && pip(pv.c[0], pv.c[1], c.r)) { a = c.n; break; }
        }
        provCcaaCache.set(pv.n, a);
    }
    return a;
}
function peaksInRegion(rg: Region, peaks: Peak[]): Peak[] {
    return peaks.filter((p) => p[2] >= rg.b[0] && p[2] <= rg.b[2] && p[1] >= rg.b[1] && p[1] <= rg.b[3] && pip(p[2], p[1], rg.r));
}

// Mapa de rutas de Wikiloc centrado en la cima (bbox ~3 km): muestra las rutas que pasan por ahi, no una busqueda generica por nombre.
function wikilocMapUrl(p: Peak) {
    const dLat = 0.015;
    const dLon = 0.015 / Math.max(0.2, Math.cos((p[1] * Math.PI) / 180));
    const f = (n: number) => n.toFixed(5);
    return 'https://es.wikiloc.com/wikiloc/map.do?sw=' + f(p[1] - dLat) + ',' + f(p[2] - dLon) + '&ne=' + f(p[1] + dLat) + ',' + f(p[2] + dLon);
}

// Estimacion de celdas totales de una region (muestreo 48x48 de su bbox) y celdas reveladas dentro.
// Sirve para la ficha de region al tocar el mapa: % revelado dentro de ella.
const regionTotalCache = new Map<string, number>();
function regionTotalCells(rg: Region) {
    let t = regionTotalCache.get(rg.n);
    if (t == null) {
        const b = rg.b, rows = 48;
        let inside = 0;
        for (let i = 0; i < rows; i++) for (let j = 0; j < rows; j++) {
            const lat = b[1] + (b[3] - b[1]) * (i + 0.5) / rows, lon = b[0] + (b[2] - b[0]) * (j + 0.5) / rows;
            if (pip(lon, lat, rg.r)) inside++;
        }
        const latMid = (b[1] + b[3]) / 2;
        const areaKm2 = (inside / (rows * rows)) * (b[2] - b[0]) * 111.32 * Math.cos(latMid * Math.PI / 180) * (b[3] - b[1]) * 110.54;
        t = Math.max(1, Math.round(areaKm2 / 1.1));
        regionTotalCache.set(rg.n, t);
    }
    return t;
}
const regionRevCache = new Map<string, number>();
function regionRevealedCells(rg: Region, cells: string[]) {
    const key = rg.n + '|' + cells.length;
    let v = regionRevCache.get(key);
    if (v == null) {
        v = 0;
        const b = rg.b;
        for (const ck of cells) {
            const i = ck.indexOf(',');
            const lat = +ck.slice(0, i) * CELL, lon = +ck.slice(i + 1) * CELL;
            if (lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3] && pip(lon, lat, rg.r)) v++;
        }
        regionRevCache.set(key, v);
    }
    return v;
}

// v1.3: aventuras (salida del dia) y rachas (dias seguidos revelando)
interface ActiveAdventure { start: string; km: number; points: number; countries0: string[]; ccaa0: string[]; prov0: string[]; peaks0: string[]; points0?: number; times?: number[]; }
interface Streak { last: string; count: number; }
const ADV_ACTIVE_KEY = 'terraunlock.adventure.active.v1';
const ADVS_KEY = 'terraunlock.adventures.v1';
const STREAK_KEY = 'terraunlock.streak.v1';
const WEEK_KEY = 'terraunlock.weekly.v1';
const WEEKKM_DONE_KEY = 'terraunlock.weekkm.done.v1'; // v1.62: semana celebrada del objetivo de distancia
const WEEK_TERR = 3; // territorios nuevos (pais + comunidad + provincia) para cumplir
const WEEK_PEAK = 1; // o esta cantidad de cimas
interface WeeklyGoal { week: string; countries0: string[]; ccaa0: string[]; prov0: string[]; peaks0: string[]; celebrated: boolean; }
// Semana ISO 8601 (lunes-domingo), clave tipo 2026-W39.
function weekKey(d: Date): string {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = (t.getUTCDay() + 6) % 7;
    t.setUTCDate(t.getUTCDate() - day + 3);
    const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    const fday = (firstThu.getUTCDay() + 6) % 7;
    firstThu.setUTCDate(firstThu.getUTCDate() - fday + 3);
    const w = 1 + Math.round((t.getTime() - firstThu.getTime()) / 604800000);
    return t.getUTCFullYear() + '-W' + String(w).padStart(2, '0');
}
function daysLeftThisWeek(d: Date): number { return 7 - ((d.getDay() + 6) % 7) - 1; }

// v1.17: ritmo medio y mejor km (o milla) de una aventura con timestamps reales
interface PaceStats { avg: number; best: number | null; } // segundos por unidad (km o mi)
function paceStats(adv: Adventure, perMile: boolean): PaceStats | null {
    if (!adv.track || !adv.times || adv.times.length !== adv.track.length || adv.track.length < 2) return null;
    const unit = perMile ? 1.609344 : 1;
    const totalKm = adv.km > 0 ? adv.km : 0;
    if (totalKm < 0.05) return null;
    const totalSec = (adv.times[adv.times.length - 1] - adv.times[0]) / 1000;
    if (totalSec <= 0) return null;
    const avg = totalSec / (totalKm / unit);
    // v1.21.1: suelo de cordura - menos de 15 s/km (~240 km/h) es dato corrupto, no actividad real
    if (avg < 15) return null;
    // mejor tramo de 1 unidad sobre la traza diezmada
    const d: number[] = [0];
    for (let i = 1; i < adv.track.length; i++) d.push(d[i - 1] + distM(adv.track[i - 1], adv.track[i]) / 1000);
    const dMax = d[d.length - 1];
    let best: number | null = null;
    if (dMax >= unit) {
        let j = 0;
        for (let i = 0; i < d.length; i++) {
            while (j < d.length - 1 && d[j + 1] - d[i] <= unit) j++;
            // v1.21.2: con trazas diezmadas el tramo puede quedar muy por debajo de la unidad;
            // se acepta desde media unidad y se escala por la distancia real del tramo
            if (j <= i || d[j] - d[i] < unit * 0.5) continue;
            const sec = (adv.times[j] - adv.times[i]) / 1000;
            const pace = sec / ((d[j] - d[i]) / unit);
            if (sec > 10 && (best === null || pace < best)) best = pace;
        }
    }
    return { avg, best };
}
// v1.40: tiempo en movimiento y pausas a partir de los timestamps por punto.
// Umbral de pausa adaptativo: el mayor de 90 s o 5x el delta mediano (la traza va diezmada a ~300 puntos).
function movingStats(adv: Adventure): { moveMs: number; pauseMs: number } | null {
    if (!adv.times || adv.times.length < 2) return null;
    const ds: number[] = [];
    for (let i = 1; i < adv.times.length; i++) {
        const dt = adv.times[i] - adv.times[i - 1];
        if (dt > 0) ds.push(dt);
    }
    if (!ds.length) return null;
    const med = [...ds].sort((a, b) => a - b)[Math.floor(ds.length / 2)];
    const GAP = Math.max(90000, med * 5);
    let move = 0;
    for (const dt of ds) if (dt <= GAP) move += dt;
    const total = adv.times[adv.times.length - 1] - adv.times[0];
    if (total <= 0) return null;
    return { moveMs: move, pauseMs: Math.max(0, total - move) };
}
function fmtDur(ms: number): string {
    const m = Math.round(ms / 60000);
    if (m >= 60) return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min';
    return m + ' min';
}
function fmtPace(secPerUnit: number, perMile: boolean): string {
    const m = Math.floor(secPerUnit / 60), s = Math.round(secPerUnit % 60);
    return m + ':' + String(s).padStart(2, '0') + '/' + (perMile ? 'mi' : 'km');
}
// v1.41: tipo de actividad (emoji en el historial). Strava lo dice; el resto se infiere del ritmo medio.
type Sport = 'run' | 'ride' | 'walk' | 'hike';
function sportEmoji(s?: Sport): string { return s === 'run' ? '🏃' : s === 'ride' ? '🚴' : s === 'walk' ? '🚶' : s === 'hike' ? '🥾' : ''; }
// v1.72: chip accesible (teclado + lector de pantalla) para los filtros
function Chip({ on, label, onPick, title }: { on: boolean; label: string; onPick: () => void; title?: string }) {
    return <span role="button" tabIndex={0} aria-pressed={on} title={title}
        className={'tu-sportchip' + (on ? ' on' : '')} style={{ cursor: 'pointer' }}
        onClick={onPick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } }}>{label}</span>;
}
// <3 min/km (~20+ km/h) = bici; 3-7,5 = correr; 7,5-14 = caminar; >14 = senderismo (terreno lento)
function inferSportSecPerKm(secPerKm: number): Sport { if (secPerKm < 180) return 'ride'; if (secPerKm < 450) return 'run'; if (secPerKm < 840) return 'walk'; return 'hike'; }
function advSport(a: Adventure): Sport | undefined {
    const s = a.sport;
    if (s === 'run' || s === 'ride' || s === 'walk' || s === 'hike') return s;
    if (a.times && a.times.length >= 2 && a.km > 0.05) {
        const sec = (a.times[a.times.length - 1] - a.times[0]) / 1000;
        if (sec > 0) return inferSportSecPerKm(sec / a.km);
    }
    return undefined;
}
function newWeeklyGoal(p: Progress): WeeklyGoal {
    return { week: weekKey(new Date()), countries0: p.countries, ccaa0: p.ccaa, prov0: p.prov, peaks0: p.peaks, celebrated: false };
}
function loadJson<T>(key: string): T | null { try { const raw = localStorage.getItem(key); if (raw) return JSON.parse(raw) as T; } catch { /* sin datos */ } return null; }
function saveJson(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* sin espacio */ } }
function dayKey(d: Date) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

// v1.2: logros. Definicion declarativa; el desbloqueo se evalua sobre el progreso actual.
interface Achievement { id: string; ico: string; title: string; hint: string; test: (p: Progress, s: { count: number }) => boolean; }
const ACHIEVEMENTS: Achievement[] = [
    { id: 'first-zone', ico: '👣', title: 'Primeros pasos', hint: 'Revela tu primera zona del mapa', test: (p) => p.cells.length >= 1 },
    { id: 'km-10', ico: '🏘️', title: 'Barrio propio', hint: 'Revela 10 km2 de superficie', test: (p) => p.cells.length * 1.1 >= 10 },
    { id: 'km-100', ico: '🗺️', title: 'Cartografo local', hint: 'Revela 100 km2 de superficie', test: (p) => p.cells.length * 1.1 >= 100 },
    { id: 'km-1000', ico: '🌐', title: 'Cartografo nacional', hint: 'Revela 1.000 km2 de superficie', test: (p) => p.cells.length * 1.1 >= 1000 },
    { id: 'country-1', ico: '🚩', title: 'Primera bandera', hint: 'Pisa tu primer pais', test: (p) => p.countries.length >= 1 },
    { id: 'country-5', ico: '🛂', title: 'Pasaporte sellado', hint: 'Pisa 5 paises distintos', test: (p) => p.countries.length >= 5 },
    { id: 'country-10', ico: '🌍', title: 'Trotamundos', hint: 'Pisa 10 paises distintos', test: (p) => p.countries.length >= 10 },
    { id: 'country-25', ico: '🌏', title: 'Sin fronteras', hint: 'Pisa 25 paises distintos', test: (p) => p.countries.length >= 25 },
    { id: 'ccaa-1', ico: '🏠', title: 'Comunidad propia', hint: 'Desbloquea tu primera comunidad', test: (p) => p.ccaa.length >= 1 },
    { id: 'ccaa-19', ico: '🇪🇸', title: 'Espana completa', hint: 'Desbloquea las 19 comunidades', test: (p) => p.ccaa.length >= 19 },
    { id: 'prov-1', ico: '📍', title: 'Provincia propia', hint: 'Desbloquea tu primera provincia', test: (p) => p.prov.length >= 1 },
    { id: 'peak-1', ico: '⛰️', title: 'Primera cima', hint: 'Conquista tu primera cima', test: (p) => p.peaks.length >= 1 },
    { id: 'peak-10', ico: '🎒', title: 'Coleccionista de cimas', hint: 'Conquista 10 cimas', test: (p) => p.peaks.length >= 10 },
    { id: 'peak-25', ico: '🗻', title: 'Montanero de verdad', hint: 'Conquista 25 cimas', test: (p) => p.peaks.length >= 25 },
    { id: 'points-100', ico: '🏃', title: 'En movimiento', hint: 'Registra 100 puntos GPS', test: (p) => p.points.length >= 100 },
    { id: 'points-1000', ico: '💨', title: 'Imparable', hint: 'Registra 1.000 puntos GPS', test: (p) => p.points.length >= 1000 },
    { id: 'streak-3', ico: '🔥', title: 'En racha', hint: 'Revela territorio 3 dias seguidos', test: (p, st) => st.count >= 3 },
    { id: 'streak-7', ico: '📅', title: 'Semana de conquista', hint: 'Revela territorio 7 dias seguidos', test: (p, st) => st.count >= 7 },
    { id: 'multi-3', ico: '🚴', title: 'Multideporte', hint: 'Registra aventuras de 3 deportes distintos', test: () => false },
    { id: 'dist-50', ico: '🛤️', title: 'En ruta', hint: 'Recorre 50 km en aventuras', test: () => false },
    { id: 'dist-250', ico: '🚞', title: 'Viajero incansable', hint: 'Recorre 250 km en aventuras', test: () => false },
    { id: 'dist-1000', ico: '🚀', title: 'Mil kilometros', hint: 'Recorre 1.000 km en aventuras', test: () => false },
    { id: 'up-1000', ico: '🧗', title: 'Piernas de acero', hint: 'Acumula 1.000 m de desnivel', test: () => false },
    { id: 'up-5000', ico: '🦅', title: 'Altitud seria', hint: 'Acumula 5.000 m de desnivel', test: () => false },
    { id: 'up-8848', ico: '🏔️', title: 'Everest', hint: 'Acumula 8.848 m de desnivel: la altura del Everest', test: () => false },
    { id: 'wstreak-2', ico: '✅', title: 'Constancia', hint: 'Cumple el objetivo semanal 2 semanas seguidas', test: () => false },
    { id: 'wstreak-4', ico: '📆', title: 'Mes imparable', hint: 'Cumple el objetivo semanal 4 semanas seguidas', test: () => false },
    { id: 'wstreak-8', ico: '🗓️', title: 'Dos meses conquistando', hint: 'Cumple el objetivo semanal 8 semanas seguidas', test: () => false },
    { id: 'wstreak-12', ico: '🏆', title: 'Trimestre de leyenda', hint: 'Cumple el objetivo semanal 12 semanas seguidas', test: () => false },
];
// v1.15: racha de semanas seguidas cumpliendo el objetivo semanal
interface WeekStreak { last: string; count: number; }
const WSTREAK_KEY = 'terraunlock.weekstreak.v1';

const ACH_KEY = 'terraunlock.achievements.v1';
function loadAch(): Record<string, string> | null {
    try { const raw = localStorage.getItem(ACH_KEY); if (raw) return JSON.parse(raw); } catch { /* sin logros */ }
    return null;
}
function saveAch(a: Record<string, string>) { try { localStorage.setItem(ACH_KEY, JSON.stringify(a)); } catch { /* sin espacio */ } }

// Preferencias de la app (ajustes): perfil visible, mapa, unidades, bienvenida
interface Prefs { nombre: string; fog: number; peakLabels: boolean; units: 'metric' | 'imperial'; welcomed: boolean; lang?: Lang; routes?: boolean; theme?: 'dark' | 'light'; weekKm?: number; }
const PREFS_KEY = 'terraunlock.prefs.v1';
const AVATAR_KEY = 'terraunlock.avatar.v1';
function loadPrefs(): Prefs {
    const base: Prefs = { nombre: '', fog: 0.68, peakLabels: true, units: 'metric', welcomed: false, theme: 'dark' };
    try { const p = JSON.parse(localStorage.getItem(PREFS_KEY) || ''); if (p && typeof p === 'object') return { ...base, ...p }; } catch { /* sin prefs */ }
    return base;
}

// Cache de region por celda: en un lote de tracks, los puntos contiguos caen en la misma celda
const regionCache = new Map<string, { c: string | null; a: string | null; pv: string | null }>();
function regionsCached(lon: number, lat: number) {
    const key = Math.round(lat / CELL) + ',' + Math.round(lon / CELL);
    let r = regionCache.get(key);
    if (!r) {
        r = { c: regionAt(COUNTRIES, lon, lat), a: null, pv: null };
        if (lon >= SPAIN_BBOX[0] && lon <= SPAIN_BBOX[2] && lat >= SPAIN_BBOX[1] && lat <= SPAIN_BBOX[3]) {
            r.a = regionAt(CCAA, lon, lat);
            r.pv = regionAt(PROV, lon, lat);
        }
        if (regionCache.size > 500000) regionCache.clear();
        regionCache.set(key, r);
    }
    return r;
}

type TrackScan = {
    name: string; pts: [number, number][]; km: number;
    countries: string[]; ccaa: string[]; prov: string[]; peaks: string[]; cells: string[];
    times?: (string | null)[];
    dup?: boolean;
    stravaId?: number;
    sport?: string;
};

function parseGpx(text: string): { name: string; pts: [number, number][]; times: (string | null)[] } {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error(t('XML no valido'));
    const name = doc.querySelector('trk > name')?.textContent || doc.querySelector('metadata > name')?.textContent || 'Ruta GPX';
    const pts: [number, number][] = [];
    const times: (string | null)[] = [];
    doc.querySelectorAll('trkpt, rtept, wpt').forEach((el) => {
        const lat = parseFloat(el.getAttribute('lat') || ''), lon = parseFloat(el.getAttribute('lon') || '');
        if (isFinite(lat) && isFinite(lon)) { pts.push([lat, lon]); times.push(el.querySelector('time')?.textContent || null); }
    });
    if (pts.length < 2) throw new Error(t('Sin puntos de track'));
    return { name, pts, times };
}

// v1.29: huella de una actividad para deduplicar importaciones (extremos de la traza + km en decimas)
function trackGeom(pts: [number, number][], km: number): string {
    const f = pts[0], l = pts[pts.length - 1];
    if (!f || !l) return '';
    return f[0].toFixed(3) + ',' + f[1].toFixed(3) + '>' + l[0].toFixed(3) + ',' + l[1].toFixed(3) + ':' + Math.round(km * 10);
}
function dupSets(advs: Adventure[]) {
    const sig = new Set<string>(), geom = new Set<string>();
    for (const a of advs) {
        if (!a.track || a.track.length < 2) continue;
        const g = trackGeom(a.track, a.km);
        if (!g) continue;
        geom.add(g);
        sig.add((a.start || '').slice(0, 16) + '|' + g);
    }
    return { sig, geom };
}

// Escanea un track contra el progreso actual: que celdas revela y que desbloquea (sin mutar nada)
function scanTrack(name: string, raw: [number, number][], p: Progress, peakGrid: Map<string, Peak[]>, times?: (string | null)[]): TrackScan {
    // Adelgazar: un punto cada ~50 m como minimo, tope 12.000
    const pts: [number, number][] = [];
    for (const q of raw) { const last = pts[pts.length - 1]; if (!last || distM(last, q) >= 50) pts.push(q); if (pts.length >= 12000) break; }
    if (raw.length && pts[pts.length - 1] !== raw[raw.length - 1]) pts.push(raw[raw.length - 1]);
    let km = 0; for (let i = 1; i < pts.length; i++) km += distM(pts[i - 1], pts[i]) / 1000;
    const cells = new Set(p.cells);
    const countries = new Set(p.countries), ccaa = new Set(p.ccaa), prov = new Set(p.prov), peaks = new Set(p.peaks);
    const nCountries: string[] = [], nCcaa: string[] = [], nProv: string[] = [], nPeaks: string[] = [];
    for (const q of pts) {
        cells.add(Math.round(q[0] / CELL) + ',' + Math.round(q[1] / CELL));
        const rg = regionsCached(q[1], q[0]);
        if (rg.c && !countries.has(rg.c)) { countries.add(rg.c); nCountries.push(rg.c); }
        if (rg.a && !ccaa.has(rg.a)) { ccaa.add(rg.a); nCcaa.push(rg.a); }
        if (rg.pv && !prov.has(rg.pv)) { prov.add(rg.pv); nProv.push(rg.pv); }
        const gi = Math.floor(q[0] * 2), gj = Math.floor(q[1] * 2);
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
            const arr = peakGrid.get((gi + di) + ',' + (gj + dj)); if (!arr) continue;
            for (const pk of arr) {
                const id = peakId(pk);
                if (!peaks.has(id) && distM([pk[1], pk[2]], q) <= PEAK_M) { peaks.add(id); nPeaks.push(id); }
            }
        }
    }
    return { name, pts, km, countries: nCountries, ccaa: nCcaa, prov: nProv, peaks: nPeaks, cells: [...cells], times };
}

// v1.26: silueta estatica de una region con las celdas reveladas (sin tiles)
function RegionShape({ rg, cells }: { rg: Region; cells: string[] }) {
    const ref = useRef<HTMLCanvasElement | null>(null);
    useEffect(() => {
        const cv = ref.current; if (!cv) return;
        const g = cv.getContext('2d'); if (!g) return;
        const pw = cv.width, ph = cv.height, pad = 10;
        g.fillStyle = '#0d1420'; g.fillRect(0, 0, pw, ph);
        const spanLo = Math.max(1e-9, rg.b[2] - rg.b[0]), spanLa = Math.max(1e-9, rg.b[3] - rg.b[1]);
        const sc = Math.min((pw - pad * 2) / spanLo, (ph - pad * 2) / spanLa);
        const offX = pad + ((pw - pad * 2) - spanLo * sc) / 2;
        const offY = pad + ((ph - pad * 2) - spanLa * sc) / 2;
        const X = (lo: number) => offX + (lo - rg.b[0]) * sc;
        const Y = (la: number) => ph - (offY + (la - rg.b[1]) * sc);
        g.beginPath();
        for (const ring of rg.r) {
            for (let i = 0; i < ring.length; i += 2) { const x = X(ring[i]), y = Y(ring[i + 1]); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); }
            g.closePath();
        }
        g.fillStyle = '#16222f'; g.fill();
        g.fillStyle = 'rgba(45,200,170,0.75)';
        const cellPx = Math.max(1.5, CELL * sc);
        for (const ck of cells) {
            const ci = ck.indexOf(',');
            const cla = +ck.slice(0, ci) * CELL, clo = +ck.slice(ci + 1) * CELL;
            if (clo < rg.b[0] || clo > rg.b[2] || cla < rg.b[1] || cla > rg.b[3]) continue;
            if (!pip(clo, cla, rg.r)) continue;
            g.fillRect(X(clo - CELL / 2), Y(cla + CELL / 2), cellPx, cellPx);
        }
        g.beginPath();
        for (const ring of rg.r) {
            for (let i = 0; i < ring.length; i += 2) { const x = X(ring[i]), y = Y(ring[i + 1]); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); }
            g.closePath();
        }
        g.strokeStyle = '#2dc8aa'; g.lineWidth = 1.5; g.stroke();
    }, [rg, cells]);
    return <canvas ref={ref} width={640} height={300} style={{ width: '100%', borderRadius: 12, border: '1px solid #1c2733', display: 'block', margin: '8px 0' }} />;
}

// v1.32: silueta reutilizable de una region en una caja cualquiera (panel semanal y tarjeta)
function drawRegionShape(g: CanvasRenderingContext2D, rg: Region, px: number, py: number, pw: number, ph: number, pad: number, fill: string, stroke: string, lw = 1.5) {
    const spanLo = Math.max(1e-9, rg.b[2] - rg.b[0]), spanLa = Math.max(1e-9, rg.b[3] - rg.b[1]);
    const sc = Math.min((pw - pad * 2) / spanLo, (ph - pad * 2) / spanLa);
    const offX = px + pad + ((pw - pad * 2) - spanLo * sc) / 2;
    const offTop = pad + ((ph - pad * 2) - spanLa * sc) / 2;
    const X = (lo: number) => offX + (lo - rg.b[0]) * sc;
    const Y = (la: number) => py + ph - offTop - (la - rg.b[1]) * sc;
    g.beginPath();
    for (const ring of rg.r) {
        for (let i = 0; i < ring.length; i += 2) { const x = X(ring[i]), y = Y(ring[i + 1]); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); }
        g.closePath();
    }
    g.fillStyle = fill; g.fill();
    g.strokeStyle = stroke; g.lineWidth = lw; g.stroke();
}

function regionZoom(rg: Region): number {
    const span = Math.max(rg.b[2] - rg.b[0], rg.b[3] - rg.b[1]);
    return span > 40 ? 3 : span > 20 ? 4 : span > 10 ? 5 : span > 5 ? 6 : span > 2 ? 7 : 9;
}

// silueta pequena para la fila de la semana
// v1.87: mini mapa mundi del inicio (misma proyeccion equirectangular que las tarjetas)
function MiniWorld({ cells, countries }: { cells: string[]; countries: string[] }) {
    const ref = useRef<HTMLCanvasElement | null>(null);
    useEffect(() => {
        const cv = ref.current; if (!cv) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = cv.clientWidth, h = cv.clientHeight;
        if (!w || !h) return;
        cv.width = w * dpr; cv.height = h * dpr;
        const g = cv.getContext('2d'); if (!g) return;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);
        const px = (lon: number) => (lon + 180) / 360 * w;
        const py = (lat: number) => (80 - lat) / 160 * h;
        g.lineWidth = 0.6;
        for (const rg of COUNTRIES) {
            const won = countries.includes(rg.n);
            for (const ring of rg.r) {
                g.beginPath();
                for (let i = 0; i < ring.length; i += 2) { const x = px(ring[i]), y = py(ring[i + 1]); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); }
                g.closePath();
                if (won) { g.fillStyle = 'rgba(45,200,170,0.16)'; g.fill(); }
                g.strokeStyle = 'rgba(110,140,155,0.45)'; g.stroke();
            }
        }
        g.fillStyle = '#2dc8aa';
        for (const ck of cells) {
            const i = ck.indexOf(',');
            const lat = +ck.slice(0, i) * CELL, lon = +ck.slice(i + 1) * CELL;
            g.fillRect(px(lon) - 1.2, py(lat) - 1.2, 2.4, 2.4);
        }
    }, [cells, countries]);
    return <canvas ref={ref} className="tu-hero-canvas" aria-hidden="true" />;
}

function WeekShape({ rg, stroke }: { rg: Region; stroke: string }) {
    const ref = useRef<HTMLCanvasElement | null>(null);
    useEffect(() => {
        const cv = ref.current; if (!cv) return;
        const g = cv.getContext('2d'); if (!g) return;
        g.clearRect(0, 0, cv.width, cv.height);
        drawRegionShape(g, rg, 0, 0, cv.width, cv.height, 10, 'rgba(45,200,170,0.10)', stroke, 2);
    }, [rg, stroke]);
    return <canvas ref={ref} width={128} height={84} style={{ width: 64, height: 42, display: 'block', margin: '0 auto' }} />;
}

export function App() {
    const [progress, setProgress] = useState<Progress>(loadProgress);
    const progressRef = useRef(progress); progressRef.current = progress;
    const [view, setView] = useState(() => {
        try {
            const v = JSON.parse(localStorage.getItem(VIEW_KEY) || '');
            if (v && typeof v.lon === 'number' && typeof v.lat === 'number' && typeof v.z === 'number'
                && v.lon >= -180 && v.lon <= 180 && v.lat >= -80 && v.lat <= 80 && v.z >= 2 && v.z <= 16) {
                return v as { lon: number; lat: number; z: number };
            }
        } catch { /* sin vista guardada */ }
        return { lon: -3.7, lat: 40.2, z: 5 };
    });
    const viewRef = useRef(view); viewRef.current = view;
    const [gpsOn, setGpsOn] = useState(false);
    const [simMode, setSimMode] = useState(false);
    const [tab, setTab] = useState<'inicio' | 'mapa' | 'progreso' | 'cimas' | 'ajustes'>('inicio');
    const [prefs, setPrefsState] = useState<Prefs>(() => { const p = loadPrefs(); setLang(p.lang || detectLang()); return p; });
    const prefsRef = useRef(prefs); prefsRef.current = prefs;
    const setPrefs = (patch: Partial<Prefs>) => {
        const next = { ...prefsRef.current, ...patch };
        prefsRef.current = next; // v1.63b: dos setPrefs seguidos en el mismo handler (importar) no se pisan
        if (patch.lang) setLang(patch.lang);
        setPrefsState(next);
        try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* sin espacio */ }
    };
    // v1.34: aviso persistente cuando el SW detecta una version nueva
    useEffect(() => {
        const onUpd = () => setSwUpdate(true);
        window.addEventListener('tu-sw-update', onUpd);
        return () => window.removeEventListener('tu-sw-update', onUpd);
    }, []);
    // v1.61: tema claro/oscuro (interfaz; el mapa sigue siendo imagen de satelite)
    useEffect(() => {
        const th = prefs.theme || 'dark';
        try {
            document.documentElement.dataset.theme = th;
            const meta = document.querySelector('meta[name="theme-color"]');
            if (meta) meta.setAttribute('content', th === 'light' ? '#eef2f6' : '#0b1017');
        } catch { /* sin DOM */ }
    }, [prefs.theme]);
    const imp = prefs.units === 'imperial';
    const fmtDist = (km: number) => imp ? dec(km * 0.621371) + ' mi' : dec(km) + ' km';
    const fmtAreaShort = (k2: number) => (imp ? dec(k2 * 0.386102, 0) + ' mi2' : dec(k2, 0) + ' km2');
    const [gpsMsg, setGpsMsg] = useState('');
    const [lastPos, setLastPos] = useState<[number, number] | null>(null);
    const [toast, setToast] = useState('');
    const [swUpdate, setSwUpdate] = useState(false);
    const [ioText, setIoText] = useState('');
    const [confirmReset, setConfirmReset] = useState(false);
    type ImportBatch = { scans: TrackScan[]; files: number; tracksOk: number; failed: number; totalKm: number; work: Progress; dups: number };
    const [importBatch, setImportBatch] = useState<ImportBatch | null>(null);
    // v1.39: Strava
    const [strava, setStrava] = useState<StravaConn | null>(() => loadStrava());
    const [stravaBusy, setStravaBusy] = useState(false);
    const importFromStrava = async () => {
        if (stravaBusy) return;
        setStravaBusy(true);
        try {
            const r = await fetchStravaTracks((d, tot) => setToast(t('Descargando de Strava: {d}/{tot}', { d, tot })));
            const c = loadStrava();
            if (c) { c.lastSync = new Date().toISOString(); saveStrava(c); }
            setStrava(loadStrava());
            if (!r.tracks.length) {
                setToast(r.rateLimited ? t('Strava ha llegado a su limite de peticiones: prueba de nuevo en 15 minutos') : t('No hay actividades nuevas con GPS en tu Strava'));
                return;
            }
            const ok = buildBatchFromTracks(r.tracks, r.tracks.length, 0);
            if (ok && r.rateLimited) setToast(t('Strava limito la descarga: faltan actividades por traer. Repite en 15 minutos.'));
        } catch (e) {
            setStrava(loadStrava());
            setToast(t('Error con Strava: {msg}', { msg: e instanceof Error ? e.message : 'error' }));
        } finally { setStravaBusy(false); }
    };
    // v1.44: al volver del OAuth de Strava, conectar y lanzar la primera importacion sin mas toques
    useEffect(() => {
        const q = new URLSearchParams(window.location.search);
        if (q.get('error')) {
            try { window.history.replaceState({}, '', window.location.pathname); } catch { /* ok */ }
            setToast(t('Conexion con Strava cancelada'));
            return;
        }
        if (!q.get('code') || !q.get('state')) return;
        completeStravaConnect()
            .then((name) => {
                setStrava(loadStrava());
                setToast(t('Strava conectado{who}. Importando tus actividades...', { who: name ? ' (' + name + ')' : '' }));
                void importFromStrava();
            })
            .catch(() => setToast(t('No se pudo conectar con Strava')));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const [wStep, setWStep] = useState(0);
    const [focusAdv, setFocusAdv] = useState<Adventure | null>(null);
    const [batchBusy, setBatchBusy] = useState(false);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const wrapRef = useRef<HTMLDivElement>(null);
    const fogRef = useRef<HTMLCanvasElement | null>(null);
    const wakeRef = useRef<{ release?: () => Promise<void> } | null>(null);
    const tileCache = useRef(new Map<string, HTMLImageElement | 'loading' | 'error'>());
    const tileRaf = useRef(0);
    const [tileTick, setTileTick] = useState(0);
    // v1.90: pulso visual en las celdas recien reveladas por GPS en vivo
    const [flash, setFlash] = useState<{ key: string; t: number }[]>([]);
    const onTileLoad = () => {
        if (tileRaf.current) return;
        tileRaf.current = requestAnimationFrame(() => { tileRaf.current = 0; setTileTick((t) => t + 1); });
    };

    // Cimas del mundo completas (Geonames, top 400 por pais): carga perezosa y cacheada por el SW
    const [worldPeaks, setWorldPeaks] = useState<Peak[]>([]);
    useEffect(() => {
        let dead = false;
        fetch('./data/peaks-world.json')
            .then((r) => (r.ok ? r.json() : []))
            .then((rows: Peak[]) => { if (!dead && Array.isArray(rows)) setWorldPeaks(rows); })
            .catch(() => { /* sin red: se quedan las cimas base */ });
        return () => { dead = true; };
    }, []);
    const allPeaks = useMemo(() => {
        if (!worldPeaks.length) return BASE_PEAKS;
        const seen = new Set(BASE_PEAKS.map(peakId));
        return [...BASE_PEAKS, ...worldPeaks.filter((p) => !seen.has(peakId(p)))];
    }, [worldPeaks]);
    const allPeaksRef = useRef(allPeaks);
    useEffect(() => { allPeaksRef.current = allPeaks; }, [allPeaks]);
    const [selectedPeak, setSelectedPeak] = useState<Peak | null>(null);
    const [selectedRegion, setSelectedRegion] = useState<{ c: string | null; a: string | null; pv: string | null } | null>(null);

    const peakGrid = useMemo(() => {
        const g = new Map<string, Peak[]>();
        for (const p of allPeaks) {
            const k = Math.floor(p[1] * 2) + ',' + Math.floor(p[2] * 2);
            const arr = g.get(k); if (arr) arr.push(p); else g.set(k, [p]);
        }
        return g;
    }, [allPeaks]);
    const peakById = useMemo(() => { const m = new Map<string, Peak>(); for (const p of allPeaks) m.set(peakId(p), p); return m; }, [allPeaks]);

    const setViewPersist = (v: { lon: number; lat: number; z: number }) => {
        setView(v);
        try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)); } catch { /* sin espacio */ }
    };

    const addPoint = (lat: number, lon: number, live = false) => {
        const p = progressRef.current;
        const cellKey = Math.round(lat / CELL) + ',' + Math.round(lon / CELL);
        const cellSet = new Set(p.cells);
        const isNewCell = !cellSet.has(cellKey);
        const pts = p.points;
        const last = pts[pts.length - 1];
        const isNewPoint = !last || distM(last, [lat, lon]) > 20;
        const news: string[] = [];
        const next: Progress = { cells: p.cells, points: p.points, countries: p.countries, ccaa: p.ccaa, prov: p.prov, peaks: p.peaks };
        if (isNewCell) next.cells = [...p.cells, cellKey];
        if (live && isNewCell) setFlash((f) => [...f.slice(-11), { key: cellKey, t: Date.now() }]);
        if (isNewPoint) next.points = [...pts.slice(-19999), [lat, lon]];
        const terr: TerrBanner[] = [];
        if (isNewPoint) {
            const rg = regionsCached(lon, lat);
            if (rg.c && !next.countries.includes(rg.c)) { next.countries = [...next.countries, rg.c]; terr.push({ title: t('Pais nuevo: {n}', { n: rg.c }), sub: t('Ya llevas {n} de 177', { n: next.countries.length }) }); }
            if (rg.a && !next.ccaa.includes(rg.a)) { next.ccaa = [...next.ccaa, rg.a]; terr.push({ title: t('Comunidad nueva: {n}', { n: rg.a }), sub: t('Ya llevas {n} de 19', { n: next.ccaa.length }) }); }
            if (rg.pv && !next.prov.includes(rg.pv)) { next.prov = [...next.prov, rg.pv]; terr.push({ title: t('Provincia nueva: {n}', { n: rg.pv }), sub: t('Ya llevas {n} de 52', { n: next.prov.length }) }); }
            const pkSet = new Set(next.peaks);
            const gi = Math.floor(lat * 2), gj = Math.floor(lon * 2);
            for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
                const arr = peakGrid.get((gi + di) + ',' + (gj + dj)); if (!arr) continue;
                for (const pk of arr) {
                    const id = peakId(pk);
                    if (!pkSet.has(id) && distM([pk[1], pk[2]], [lat, lon]) <= PEAK_M) {
                        next.peaks = [...next.peaks, id]; pkSet.add(id);
                        news.push(t('Cima conquistada: {n} ({e} m)', { n: pk[0], e: pk[3] }));
                    }
                }
            }
        }
        if (news.length) setToast(news[news.length - 1] + (news.length > 1 ? t(' (+{n} mas)', { n: news.length - 1 }) : ''));
        if (terr.length) { setBanners((b) => [...b, ...terr]); try { navigator.vibrate?.(80); } catch { /* sin vibracion */ } }
        if (isNewCell || isNewPoint || news.length) { setProgress(next); saveProgress(next); }
        setLastPos([lat, lon]);
        const a = advRef.current;
        if (a && isNewPoint) {
            // v1.16.1: el primer punto de la aventura no suma distancia (el "last" global puede estar a cientos de km: importaciones, viajes sin registrar)
            const inc = a.points > 0 && last ? distM(last, [lat, lon]) / 1000 : 0;
            const na = { ...a, km: a.km + inc, points: a.points + 1, times: a.times ? [...a.times, Date.now()] : undefined };
            advRef.current = na; setAdv(na); saveJson(ADV_ACTIVE_KEY, na);
        }
        const today = dayKey(new Date());
        setStreak((st) => {
            if (st.last === today) return st;
            const y = new Date(); y.setDate(y.getDate() - 1);
            const ns = { last: today, count: st.last === dayKey(y) ? st.count + 1 : 1 };
            saveJson(STREAK_KEY, ns);
            return ns;
        });
    };

    // Importacion de actividades: GPX, FIT, ZIP de exportacion de Strava, .gpx.gz/.fit.gz sueltos; multiple y en lote
    const onImportFiles = async (filesIn: FileList | File[] | null | undefined) => {
        const files = filesIn ? [...filesIn] : [];
        if (!files.length) return;
        setBatchBusy(true);
        try {
            const tracks: { name: string; pts: [number, number][]; times: (string | null)[] }[] = [];
            let failed = 0;
            const pushGpx = (text: string, fallback: string) => {
                try { const g = parseGpx(text); tracks.push({ name: g.name === 'Ruta GPX' ? fallback : g.name, pts: g.pts, times: g.times }); }
                catch { failed++; }
            };
            const pushFit = async (buf: ArrayBuffer, fallback: string) => {
                try {
                    const { default: FitParser } = await import('fit-file-parser');
                    const parser = new FitParser({ mode: 'list' });
                    const data = await parser.parseAsync(buf) as { records?: { position_lat?: number; position_long?: number; timestamp?: Date | string }[] };
                    const pts: [number, number][] = [];
                    const times: (string | null)[] = [];
                    for (const r of data.records || []) {
                        if (typeof r.position_lat === 'number' && typeof r.position_long === 'number') {
                            pts.push([r.position_lat, r.position_long]);
                            times.push(r.timestamp ? new Date(r.timestamp).toISOString() : null);
                        }
                    }
                    if (pts.length < 2) throw new Error('sin puntos');
                    tracks.push({ name: fallback, pts, times });
                } catch { failed++; }
            };
            const handleEntry = async (entryName: string, bytes: Uint8Array) => {
                let data = bytes, ext = entryName.toLowerCase();
                if (ext.endsWith('.gz')) {
                    const { gunzipSync } = await import('fflate');
                    try { data = gunzipSync(bytes); ext = ext.slice(0, -3); } catch { failed++; return; }
                }
                const base = entryName.split('/').pop() || entryName;
                if (ext.endsWith('.gpx')) pushGpx(new TextDecoder().decode(data), base);
                else if (ext.endsWith('.fit')) await pushFit(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, base);
            };
            for (const f of files.slice(0, 20)) {
                if (f.name.toLowerCase().endsWith('.zip')) {
                    try {
                        const { unzipSync } = await import('fflate');
                        const entries = unzipSync(new Uint8Array(await f.arrayBuffer()), { filter: (e) => /\.(gpx|fit)(\.gz)?$/i.test(e.name) });
                        for (const n of Object.keys(entries).slice(0, 2000)) await handleEntry(n, entries[n]);
                    } catch { failed++; }
                } else {
                    await handleEntry(f.name, new Uint8Array(await f.arrayBuffer()));
                }
            }
            if (!tracks.length) { setToast(failed ? t('No se pudo leer ninguna actividad ({n} con error)', { n: failed }) : t('No se encontraron actividades GPX/FIT')); return; }
            buildBatchFromTracks(tracks, files.length, failed);
        } catch (e) { setToast(t('Importacion fallida: {msg}', { msg: e instanceof Error ? e.message : 'error' })); }
        finally { setBatchBusy(false); }
    };

    // v1.39: escanear tracks (de archivos o de Strava) contra una copia del progreso y preparar el lote de importacion
    const buildBatchFromTracks = (tracks: { name: string; pts: [number, number][]; times: (string | null)[]; stravaId?: number; sport?: string }[], files: number, failed: number): boolean => {
        try {
            const p0 = progressRef.current;
            const work: Progress = { cells: [...p0.cells], points: [...p0.points], countries: [...p0.countries], ccaa: [...p0.ccaa], prov: [...p0.prov], peaks: [...p0.peaks] };
            const scansAll: TrackScan[] = [];
            for (const t of tracks) {
                const sc = scanTrack(t.name, t.pts, work, peakGrid, t.times);
                if (t.stravaId) sc.stravaId = t.stravaId;
                if (t.sport) sc.sport = t.sport;
                scansAll.push(sc);
                work.cells = sc.cells;
                work.countries = [...work.countries, ...sc.countries];
                work.ccaa = [...work.ccaa, ...sc.ccaa];
                work.prov = [...work.prov, ...sc.prov];
                work.peaks = [...work.peaks, ...sc.peaks];
            }
            // v1.29: deduplicar contra el historial y dentro del propio lote (misma fecha+traza, o misma traza si no hay tiempos)
            const ds = dupSets(adventuresRef.current);
            const batchSig = new Set<string>(), batchGeom = new Set<string>();
            let dups = 0;
            for (const sc of scansAll) {
                const g = trackGeom(sc.pts, sc.km);
                const t0 = (sc.times || []).find((x) => x);
                const sig = (t0 ? new Date(t0).toISOString().slice(0, 16) : '') + '|' + g;
                const isDup = g ? (t0 ? (ds.sig.has(sig) || batchSig.has(sig)) : (ds.geom.has(g) || batchGeom.has(g))) : false;
                if (isDup) { sc.dup = true; dups++; } else { batchSig.add(sig); batchGeom.add(g); }
            }
            const scans = scansAll.filter((s) => !s.dup);
            if (!scans.length) { setToast(t(dups > 1 ? 'Esas {n} actividades ya las tenias importadas' : 'Esa actividad ya la tenias importada', { n: dups })); return false; }
            let totalKm = 0;
            let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
            for (const sc of scans) {
                totalKm += sc.km;
                for (const q of sc.pts) { if (q[0] < minLat) minLat = q[0]; if (q[0] > maxLat) maxLat = q[0]; if (q[1] < minLon) minLon = q[1]; if (q[1] > maxLon) maxLon = q[1]; }
            }
            const w = wrapRef.current?.clientWidth || 800, h = wrapRef.current?.clientHeight || 500;
            const spanLon = Math.max(0.001, maxLon - minLon), spanLat = Math.max(0.001, maxLat - minLat);
            const zx = Math.log2((w * 0.7 * 360) / (256 * spanLon));
            const zy = Math.log2((h * 0.7 * 360) / (256 * spanLat * 1.4));
            setViewPersist({ lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2, z: Math.max(3, Math.min(14, Math.min(zx, zy))) });
            setImportBatch({ scans, files, tracksOk: scans.length, failed, totalKm, work, dups });
            setTab('mapa');
            return true;
        } catch (e) { setToast(t('Importacion fallida: {msg}', { msg: e instanceof Error ? e.message : 'error' })); return false; }
    };

    const applyBatch = () => {
        const b = importBatch; if (!b) return;
        const p0 = progressRef.current;
        const news = {
            countries: b.work.countries.slice(p0.countries.length),
            ccaa: b.work.ccaa.slice(p0.ccaa.length),
            prov: b.work.prov.slice(p0.prov.length),
            peaks: b.work.peaks.slice(p0.peaks.length),
        };
        const newPts: [number, number][] = [];
        for (const sc of b.scans) newPts.push(...sc.pts);
        const next: Progress = { ...b.work, points: [...b.work.points, ...newPts].slice(-50000) };
        setProgress(next); saveProgress(next); setImportBatch(null);
        // v1.39: marcar actividades de Strava ya importadas para no volver a traerlas
        const sids = b.scans.map((s) => s.stravaId).filter((x): x is number => typeof x === 'number');
        if (sids.length) { const c = loadStrava(); if (c) { c.importedIds = [...new Set([...c.importedIds, ...sids])]; saveStrava(c); } }
        // v1.27: cada actividad importada queda guardada como aventura (historial + traza para perfil/ritmo)
        if (b.scans.length <= 20) {
            const newAdvs: Adventure[] = [];
            for (const sc of b.scans) {
                const vt = (sc.times || []).filter((x): x is string => !!x);
                const t0 = vt.length ? new Date(vt[0]) : new Date();
                const t1 = vt.length ? new Date(vt[vt.length - 1]) : t0;
                const start = isFinite(t0.getTime()) ? t0.toISOString() : new Date().toISOString();
                const end = isFinite(t1.getTime()) && t1.getTime() >= new Date(start).getTime() ? t1.toISOString() : start;
                const stride = Math.max(1, Math.ceil(sc.pts.length / 300));
                const tr = sc.pts.filter((_, i) => i % stride === 0);
                const lastPt = sc.pts[sc.pts.length - 1];
                const lastTr = tr[tr.length - 1];
                if (lastTr && (lastTr[0] !== lastPt[0] || lastTr[1] !== lastPt[1])) tr.push(lastPt);
                let tt: number[] | undefined;
                if (sc.times && sc.times.length === sc.pts.length) {
                    const rawMs = sc.times.map((x) => (x ? new Date(x).getTime() : NaN));
                    if (rawMs.every((n) => isFinite(n))) {
                        const dm = rawMs.filter((_, i) => i % stride === 0);
                        if (dm.length < tr.length) dm.push(rawMs[rawMs.length - 1]);
                        tt = dm;
                    }
                }
                const vt0 = vt.length >= 2 ? (new Date(vt[vt.length - 1]).getTime() - new Date(vt[0]).getTime()) / 1000 : 0;
                const sp = (sc.sport === 'run' || sc.sport === 'ride' || sc.sport === 'walk' || sc.sport === 'hike') ? sc.sport : (vt0 > 0 && sc.km > 0.05 ? inferSportSecPerKm(vt0 / sc.km) : undefined);
                newAdvs.push({ start, end, km: Math.round(sc.km * 10) / 10, points: sc.pts.length, countries: sc.countries, ccaa: sc.ccaa, prov: sc.prov, peaks: sc.peaks, track: tr.length >= 2 ? tr : undefined, times: tt, name: sc.name, sport: sp, stravaId: sc.stravaId });
            }
            const list = [...newAdvs.reverse(), ...adventuresRef.current].slice(0, 50);
            setAdventures(list); saveJson(ADVS_KEY, list);
        }
        const parts: string[] = [];
        if (news.countries.length) parts.push(t('{n} paises', { n: news.countries.length }));
        if (news.ccaa.length) parts.push(news.ccaa.length + ' CCAA');
        if (news.prov.length) parts.push(t('{n} provincias', { n: news.prov.length }));
        if (news.peaks.length) parts.push(t('{n} cimas', { n: news.peaks.length }));
        setToast((b.tracksOk > 1 ? t('Lote aplicado ({n} actividades, {km})', { n: b.tracksOk, km: fmtDist(b.totalKm) }) : t('Ruta aplicada ({km})', { km: fmtDist(b.totalKm) })) + ': ' + (parts.length ? '+' + parts.join(', +') : t('zona ya desbloqueada')));
        const tparts: string[] = [];
        if (news.prov.length) tparts.push(t(news.prov.length > 1 ? '{n} provincias' : '{n} provincia', { n: news.prov.length }));
        if (news.ccaa.length) tparts.push(t(news.ccaa.length > 1 ? '{n} comunidades' : '{n} comunidad', { n: news.ccaa.length }));
        if (news.countries.length) tparts.push(t(news.countries.length > 1 ? '{n} paises' : '{n} pais', { n: news.countries.length }));
        if (news.peaks.length) tparts.push(t(news.peaks.length > 1 ? '{n} cimas' : '{n} cima', { n: news.peaks.length }));
        if (tparts.length) { setBanners((bb) => [...bb, { title: t('Territorio nuevo por importacion'), sub: '+' + tparts.join(', +') }]); try { navigator.vibrate?.(80); } catch { /* sin vibracion */ } }
    };

    // v1.90: motor de la animacion del pulso (solo mientras haya pulsos vivos)
    useEffect(() => {
        if (!flash.length) return;
        const iv = setInterval(() => setFlash((f) => f.filter((x) => Date.now() - x.t < 1800)), 100);
        return () => clearInterval(iv);
    }, [flash.length]);

    // GPS real
    useEffect(() => {
        if (!gpsOn) return;
        if (!('geolocation' in navigator)) { setGpsMsg(t('Este navegador no expone GPS dentro de la pagina. Usa el modo prueba.')); setGpsOn(false); return; }
        const id = navigator.geolocation.watchPosition(
            (pos) => { setGpsMsg(''); addPoint(pos.coords.latitude, pos.coords.longitude, true); },
            (err) => { setGpsMsg(t('GPS no disponible: {msg}. Mientras, puedes usar el modo prueba.', { msg: err.message })); setGpsOn(false); },
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
        );
        // Mantener la pantalla despierta mientras el tracking esta activo (background real: fase nativa con Capacitor)
        const reqWake = () => {
            try {
                const nav = navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ release?: () => Promise<void> }> } };
                if (nav.wakeLock && nav.wakeLock.request) {
                    nav.wakeLock.request('screen').then((s) => { wakeRef.current = s; }).catch(() => { wakeRef.current = null; });
                }
            } catch { wakeRef.current = null; }
        };
        reqWake();
        const onVis = () => { if (document.visibilityState === 'visible') reqWake(); };
        document.addEventListener('visibilitychange', onVis);
        return () => {
            navigator.geolocation.clearWatch(id);
            document.removeEventListener('visibilitychange', onVis);
            try { if (wakeRef.current && wakeRef.current.release) wakeRef.current.release().catch(() => {}); } catch {}
            wakeRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gpsOn]);

    // v1.28: paso final del onboarding - pedir el permiso GPS en contexto
    const welcomeGps = () => {
        if (!('geolocation' in navigator)) { setPrefs({ welcomed: true }); return; }
        try {
            navigator.geolocation.getCurrentPosition(
                (pos) => { addPoint(pos.coords.latitude, pos.coords.longitude, true); setGpsOn(true); setPrefs({ welcomed: true }); },
                () => { setPrefs({ welcomed: true }); },
                { enableHighAccuracy: true, timeout: 10000 }
            );
        } catch { setPrefs({ welcomed: true }); }
    };

    // Toast temporal
    useEffect(() => {
        if (!toast) return;
        const t = setTimeout(() => setToast(''), 6000);
        return () => clearTimeout(t);
    }, [toast]);

    // Render del mapa
    useEffect(() => {
        const canvas = canvasRef.current, wrap = wrapRef.current;
        if (!canvas || !wrap) return;
        const dpr = window.devicePixelRatio || 1;
        const w = wrap.clientWidth, h = wrap.clientHeight;
        if (!w || !h) return;
        canvas.width = w * dpr; canvas.height = h * dpr;
        canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
        const ctx = canvas.getContext('2d'); if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const { lon, lat, z } = viewRef.current;
        const pc = project(lon, lat, z);
        const sx = (x: number) => x - pc.x + w / 2;
        const sy = (y: number) => y - pc.y + h / 2;
        const tl = unproject(pc.x - w / 2, pc.y - h / 2, z);
        const br = unproject(pc.x + w / 2, pc.y + h / 2, z);

        // Oceano y tierra
        ctx.fillStyle = '#0a0f16'; ctx.fillRect(0, 0, w, h);

        // Mapa base: tiles de satelite (Esri World Imagery, sin key)
        {
            const tz = Math.max(0, Math.min(TILE_MAXZ, Math.round(z)));
            const scale = Math.pow(2, z - tz);
            const ts = 256 * scale;
            const ox = pc.x - w / 2, oy = pc.y - h / 2;
            const n = Math.pow(2, tz);
            const i0 = Math.floor(ox / ts), i1 = Math.floor((ox + w) / ts);
            const j0 = Math.max(0, Math.floor(oy / ts)), j1 = Math.min(n - 1, Math.floor((oy + h) / ts));
            for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
                const ii = ((i % n) + n) % n;
                const key = tz + '/' + ii + '/' + j;
                let cached = tileCache.current.get(key);
                if (!cached) {
                    tileCache.current.set(key, 'loading');
                    const im = new Image();
                    im.crossOrigin = 'anonymous';
                    im.onload = () => {
                        tileCache.current.set(key, im);
                        if (tileCache.current.size > 600) tileCache.current.clear();
                        onTileLoad();
                    };
                    im.onerror = () => { tileCache.current.set(key, 'error'); onTileLoad(); };
                    im.src = TILE_URL(tz, j, ii);
                }
                const dx = i * ts - ox, dy = j * ts - oy;
                if (cached && cached !== 'loading' && cached !== 'error') {
                    ctx.drawImage(cached, dx, dy, ts + 0.5, ts + 0.5);
                    continue;
                }
                // Fallback: tile padre/abuelo en cache mientras carga el nivel actual
                let lvl = tz, ti = ii, tj = j;
                for (let up = 0; up < 4 && lvl > 0; up++) {
                    lvl--; ti = Math.floor(ti / 2); tj = Math.floor(tj / 2);
                    const p = tileCache.current.get(lvl + '/' + ti + '/' + tj);
                    if (!p || p === 'loading' || p === 'error') continue;
                    const f = Math.pow(2, tz - lvl);
                    const rs = 256 / f;
                    const rx = (ii - ti * f) * rs, ry = (j - tj * f) * rs;
                    ctx.drawImage(p, rx, ry, rs, rs, dx, dy, ts + 0.5, ts + 0.5);
                    break;
                }
            }
        }
        const drawRegion = (rg: Region, fill: string | null, stroke: string, lw: number) => {
            const b = rg.b;
            if (b[2] < tl.lon || b[0] > br.lon || b[3] < br.lat || b[1] > tl.lat) return;
            ctx.beginPath();
            for (const r of rg.r) {
                for (let i = 0; i < r.length; i += 2) {
                    const pt = project(r[i], r[i + 1], z);
                    if (i === 0) ctx.moveTo(sx(pt.x), sy(pt.y)); else ctx.lineTo(sx(pt.x), sy(pt.y));
                }
                ctx.closePath();
            }
            if (fill) { ctx.fillStyle = fill; ctx.fill(); }
            ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke();
        };
        const cSet = new Set(progress.countries), aSet = new Set(progress.ccaa), pSet = new Set(progress.prov), pkSet = new Set(progress.peaks);
        for (const rg of COUNTRIES) drawRegion(rg, null, 'rgba(150,190,220,0.45)', 1);
        if (z >= 3.5) for (const rg of CCAA) drawRegion(rg, null, 'rgba(120,200,180,0.40)', 1);
        if (z >= 5) for (const rg of PROV) drawRegion(rg, null, 'rgba(120,200,180,0.30)', 0.7);

        // Niebla en capa aparte
        let fog = fogRef.current;
        if (!fog) { fog = document.createElement('canvas'); fogRef.current = fog; }
        fog.width = w * dpr; fog.height = h * dpr;
        const fx = fog.getContext('2d');
        if (fx) {
            fx.setTransform(dpr, 0, 0, dpr, 0, 0);
            fx.fillStyle = 'rgba(3,6,10,' + prefsRef.current.fog + ')'; fx.fillRect(0, 0, w, h);
            fx.globalCompositeOperation = 'destination-out';
            const mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);
            const r = Math.max(14, REVEAL_M / mpp);
            for (const ck of progress.cells) {
                const ci = ck.indexOf(',');
                const clat = +ck.slice(0, ci) * CELL, clon = +ck.slice(ci + 1) * CELL;
                const pt = project(clon, clat, z);
                const x = sx(pt.x), y = sy(pt.y);
                if (x < -r || x > w + r || y < -r || y > h + r) continue;
                const g = fx.createRadialGradient(x, y, r * 0.55, x, y, r);
                g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
                fx.fillStyle = g; fx.beginPath(); fx.arc(x, y, r, 0, 7); fx.fill();
            }
            fx.globalCompositeOperation = 'source-over';
            ctx.drawImage(fog, 0, 0, w, h);
            // Resplandor sutil de lo revelado
            const mpp2 = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);
            const r2 = Math.max(8, (REVEAL_M * 0.55) / mpp2);
            ctx.fillStyle = 'rgba(240,180,41,0.12)';
            for (const ck of progress.cells) {
                const ci = ck.indexOf(',');
                const pt = project(+ck.slice(ci + 1) * CELL, +ck.slice(0, ci) * CELL, z);
                const x = sx(pt.x), y = sy(pt.y);
                if (x < -r2 || x > w + r2 || y < -r2 || y > h + r2) continue;
                ctx.beginPath(); ctx.arc(x, y, r2, 0, 7); ctx.fill();
            }
        }

        // v1.90: anillo expansivo en las celdas recien reveladas (GPS en vivo)
        if (flash.length) {
            const mpp3 = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);
            const rb = Math.max(14, REVEAL_M / mpp3);
            const now = Date.now();
            for (const f of flash) {
                const age = now - f.t;
                if (age >= 1800) continue;
                const ci = f.key.indexOf(',');
                const pt = project(+f.key.slice(ci + 1) * CELL, +f.key.slice(0, ci) * CELL, z);
                const x = sx(pt.x), y = sy(pt.y);
                if (x < -rb || x > w + rb || y < -rb || y > h + rb) continue;
                const k = age / 1800;
                const rr = rb * (0.55 + 0.75 * k);
                const al = 0.85 * (1 - k);
                ctx.strokeStyle = 'rgba(45,200,170,' + al.toFixed(3) + ')';
                ctx.lineWidth = 2.5;
                ctx.beginPath(); ctx.arc(x, y, rr, 0, 7); ctx.stroke();
                ctx.fillStyle = 'rgba(45,200,170,' + (al * 0.25).toFixed(3) + ')';
                ctx.beginPath(); ctx.arc(x, y, rr * 0.7, 0, 7); ctx.fill();
            }
        }

        // Territorio conquistado por encima de la niebla
        for (const rg of COUNTRIES) if (cSet.has(rg.n)) drawRegion(rg, 'rgba(46,184,152,0.10)', 'rgba(140,240,215,0.95)', 1.8);
        if (z >= 3.5) for (const rg of CCAA) if (aSet.has(rg.n)) drawRegion(rg, 'rgba(46,184,152,0.07)', 'rgba(140,240,215,0.80)', 1.3);
        if (z >= 5) for (const rg of PROV) if (pSet.has(rg.n)) drawRegion(rg, 'rgba(46,184,152,0.05)', 'rgba(140,240,215,0.70)', 1.1);

        // Etiquetas de regiones desbloqueadas
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const drawLabel = (name: string, c: number[], minZ: number, maxZ: number, size: number, color: string) => {
            if (z < minZ || z > maxZ) return;
            if (c[0] < tl.lon || c[0] > br.lon || c[1] < br.lat || c[1] > tl.lat) return;
            const pt = project(c[0], c[1], z);
            ctx.font = '600 ' + size + 'px sans-serif';
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillText(name, sx(pt.x) + 1, sy(pt.y) + 1);
            ctx.fillStyle = color;
            ctx.fillText(name, sx(pt.x), sy(pt.y));
        };
        for (const rg of COUNTRIES) if (cSet.has(rg.n)) drawLabel(rg.n, rg.c, 0, 6, 13, '#7ee0c8');
        for (const rg of CCAA) if (aSet.has(rg.n)) drawLabel(rg.n, rg.c, 4.5, 8, 12, '#7ee0c8');
        for (const rg of PROV) if (pSet.has(rg.n)) drawLabel(rg.n, rg.c, 7, 20, 11, '#9fe8d4');

        // Tracks del lote en preview (adelgazados si son muchos puntos)
        if (importBatch) {
            let totalPts = 0;
            for (const sc of importBatch.scans) totalPts += sc.pts.length;
            const step = Math.max(1, Math.ceil(totalPts / 60000));
            ctx.save();
            ctx.strokeStyle = '#f0b429'; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
            ctx.shadowColor = 'rgba(240,180,41,0.55)'; ctx.shadowBlur = 9;
            for (const sc of importBatch.scans) {
                ctx.beginPath();
                let started = false;
                for (let i = 0; i < sc.pts.length; i += step) {
                    const q = sc.pts[i];
                    const pt = project(q[1], q[0], z);
                    const x = sx(pt.x), y = sy(pt.y);
                    if (x < -60 || x > w + 60 || y < -60 || y > h + 60) { started = false; continue; }
                    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
            ctx.restore();
        }

        // v1.36: trazas de todas las aventuras guardadas (atenuadas), bajo la enfocada
        if (prefsRef.current.routes) {
            ctx.save();
            ctx.strokeStyle = 'rgba(45,200,170,0.4)'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
            for (const a of adventuresRef.current) {
                if (!a.track || a.track.length < 2) continue;
                if (focusAdv && a.start === focusAdv.start) continue;
                ctx.beginPath();
                let started = false;
                for (const q of a.track) {
                    const pt = project(q[1], q[0], z);
                    const x = sx(pt.x), y = sy(pt.y);
                    if (x < -60 || x > w + 60 || y < -60 || y > h + 60) { started = false; continue; }
                    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
            ctx.restore();
        }

        // v1.31: traza de la aventura enfocada (teal, inicio teal / fin amarillo)
        if (focusAdv && focusAdv.track && focusAdv.track.length >= 2) {
            const tr = focusAdv.track;
            ctx.save();
            ctx.strokeStyle = '#2dc8aa'; ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
            ctx.shadowColor = 'rgba(45,200,170,0.65)'; ctx.shadowBlur = 10;
            ctx.beginPath();
            let started = false;
            for (const q of tr) {
                const pt = project(q[1], q[0], z);
                const x = sx(pt.x), y = sy(pt.y);
                if (x < -80 || x > w + 80 || y < -80 || y > h + 80) { started = false; continue; }
                if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.shadowBlur = 0;
            const mk = (q: [number, number], color: string) => {
                const pt = project(q[1], q[0], z);
                ctx.fillStyle = color; ctx.beginPath(); ctx.arc(sx(pt.x), sy(pt.y), 7, 0, 7); ctx.fill();
                ctx.fillStyle = '#0b1017'; ctx.beginPath(); ctx.arc(sx(pt.x), sy(pt.y), 3, 0, 7); ctx.fill();
            };
            mk(tr[0], '#2dc8aa'); mk(tr[tr.length - 1], '#f0b429');
            ctx.restore();
        }

        // Cimas: solo las visibles; si hay muchas juntas, se dibuja la mas alta de cada celda de pantalla
        if (z >= 5.5) {
            const cellPx = 26;
            const grid = new Map<string, { pk: Peak; x: number; y: number; won: boolean }>();
            for (const pk of allPeaks) {
                if (pk[2] < tl.lon || pk[2] > br.lon || pk[1] < br.lat || pk[1] > tl.lat) continue;
                const pt = project(pk[2], pk[1], z);
                const x = sx(pt.x), y = sy(pt.y);
                const key = Math.floor(x / cellPx) + ',' + Math.floor(y / cellPx);
                const cur = grid.get(key);
                if (!cur || pk[3] > cur.pk[3]) grid.set(key, { pk, x, y, won: pkSet.has(peakId(pk)) });
            }
            const shown = [...grid.values()];
            for (const m of shown) {
                ctx.beginPath();
                ctx.moveTo(m.x, m.y - 5); ctx.lineTo(m.x - 4.5, m.y + 3.5); ctx.lineTo(m.x + 4.5, m.y + 3.5); ctx.closePath();
                ctx.fillStyle = m.won ? '#f0b429' : 'rgba(200,212,222,0.6)';
                ctx.fill();
            }
            if (z >= 9 && prefsRef.current.peakLabels) {
                ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
                const labeled = shown.slice().sort((a, b) => b.pk[3] - a.pk[3]).slice(0, 30);
                for (const m of labeled) {
                    ctx.fillStyle = m.won ? '#f0b429' : 'rgba(220,228,235,0.75)';
                    ctx.fillText(m.pk[0] + ' ' + m.pk[3] + 'm', m.x, m.y - 11);
                }
                ctx.textAlign = 'start';
            }
            if (selectedPeak) {
                const pt = project(selectedPeak[2], selectedPeak[1], z);
                const x = sx(pt.x), y = sy(pt.y);
                ctx.beginPath(); ctx.arc(x, y - 1, 10, 0, 7);
                ctx.lineWidth = 2; ctx.strokeStyle = '#f0b429'; ctx.stroke();
            }
        }

        // Posicion del usuario
        if (lastPos) {
            const pt = project(lastPos[1], lastPos[0], z);
            const x = sx(pt.x), y = sy(pt.y);
            // v1.93: radio de revelado visible con el GPS activo (lo que despejas al caminar)
            if (gpsOn) {
                const mpp = 156543.03392 * Math.cos(lastPos[0] * Math.PI / 180) / Math.pow(2, z);
                const rr = REVEAL_M / mpp;
                ctx.fillStyle = 'rgba(45,200,170,0.05)';
                ctx.beginPath(); ctx.arc(x, y, rr, 0, 7); ctx.fill();
                ctx.setLineDash([8, 7]);
                ctx.strokeStyle = 'rgba(45,200,170,0.45)'; ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc(x, y, rr, 0, 7); ctx.stroke();
                ctx.setLineDash([]);
            }
            ctx.beginPath(); ctx.arc(x, y, 10, 0, 7); ctx.fillStyle = 'rgba(45,200,170,0.25)'; ctx.fill();
            ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fillStyle = '#2dc8aa'; ctx.fill();
            ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.stroke();
        }
    }, [view, progress, lastPos, tileTick, importBatch, allPeaks, selectedPeak, prefs, focusAdv, tab, flash, gpsOn]);

    // Gestion de punteros (arrastre, pellizco, toque en modo prueba)
    const pointers = useRef(new Map<number, { x: number; y: number }>());
    const dragStart = useRef<{ x: number; y: number; wx: number; wy: number; moved: boolean } | null>(null);
    const pinchStart = useRef<{ d: number; z: number } | null>(null);

    const zoomAt = (mx: number, my: number, delta: number) => {
        const v = viewRef.current, wrap = wrapRef.current; if (!wrap) return;
        const nz = Math.max(2, Math.min(16, v.z + delta));
        if (nz === v.z) return;
        const w = wrap.clientWidth, h = wrap.clientHeight;
        const pc = project(v.lon, v.lat, v.z);
        const wx = pc.x + (mx - w / 2), wy = pc.y + (my - h / 2);
        const scale = Math.pow(2, v.z - nz);
        const nl = unproject(wx / scale - (mx - w / 2), wy / scale - (my - h / 2), nz);
        setViewPersist({ lon: nl.lon, lat: Math.max(-80, Math.min(80, nl.lat)), z: nz });
    };

    useEffect(() => {
        const wrap = wrapRef.current; if (!wrap) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = wrap.getBoundingClientRect();
            zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 0.4 : -0.4);
        };
        wrap.addEventListener('wheel', onWheel, { passive: false });
        return () => wrap.removeEventListener('wheel', onWheel);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab]);

    const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.current.size === 1) {
            const v = viewRef.current;
            const pc = project(v.lon, v.lat, v.z);
            dragStart.current = { x: e.clientX, y: e.clientY, wx: pc.x, wy: pc.y, moved: false };
        } else if (pointers.current.size === 2) {
            const ps = [...pointers.current.values()];
            pinchStart.current = { d: Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y), z: viewRef.current.z };
            dragStart.current = null;
        }
    };
    const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!pointers.current.has(e.pointerId)) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const wrap = wrapRef.current; if (!wrap) return;
        if (pointers.current.size === 2 && pinchStart.current) {
            const ps = [...pointers.current.values()];
            const d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
            if (d > 0 && pinchStart.current.d > 0) {
                const rect = wrap.getBoundingClientRect();
                const mx = (ps[0].x + ps[1].x) / 2 - rect.left, my = (ps[0].y + ps[1].y) / 2 - rect.top;
                const target = Math.max(2, Math.min(16, pinchStart.current.z + Math.log2(d / pinchStart.current.d)));
                zoomAt(mx, my, target - viewRef.current.z);
            }
        } else if (dragStart.current) {
            const dx = e.clientX - dragStart.current.x, dy = e.clientY - dragStart.current.y;
            if (Math.abs(dx) + Math.abs(dy) > 4) dragStart.current.moved = true;
            const v = viewRef.current;
            const nl = unproject(dragStart.current.wx - dx, dragStart.current.wy - dy, v.z);
            setViewPersist({ lon: nl.lon, lat: Math.max(-80, Math.min(80, nl.lat)), z: v.z });
        }
    };
    const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const wasTap = pointers.current.size === 1 && dragStart.current && !dragStart.current.moved;
        pointers.current.delete(e.pointerId);
        if (pointers.current.size < 2) pinchStart.current = null;
        if (wasTap) {
            const wrap = wrapRef.current;
            if (wrap) {
                const rect = wrap.getBoundingClientRect();
                const v = viewRef.current;
                const pc = project(v.lon, v.lat, v.z);
                const mx = e.clientX - rect.left, my = e.clientY - rect.top;
                const w = wrap.clientWidth, h = wrap.clientHeight;
                // Hit-test de cimas: la mas cercana al toque dentro de 20 px
                if (v.z >= 5.5) {
                    let best: Peak | null = null, bestD = 20;
                    for (const pk of allPeaksRef.current) {
                        const pt = project(pk[2], pk[1], v.z);
                        const x = pt.x - pc.x + w / 2, y = pt.y - pc.y + h / 2;
                        if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
                        const d = Math.hypot(x - mx, y - (my - 1));
                        if (d < bestD) { bestD = d; best = pk; }
                    }
                    if (best) { setSelectedPeak(best); setSelectedRegion(null); dragStart.current = null; return; }
                }
                if (simMode) {
                    const ll = unproject(pc.x + (mx - w / 2), pc.y + (my - h / 2), v.z);
                    addPoint(ll.lat, ll.lon);
                    setSelectedRegion(null);
                } else {
                    if (selectedPeak) setSelectedPeak(null);
                    const ll = unproject(pc.x + (mx - w / 2), pc.y + (my - h / 2), v.z);
                    const c = regionAt(COUNTRIES, ll.lon, ll.lat);
                    const inSpain = ll.lon >= SPAIN_BBOX[0] && ll.lon <= SPAIN_BBOX[2] && ll.lat >= SPAIN_BBOX[1] && ll.lat <= SPAIN_BBOX[3];
                    const a = inSpain ? regionAt(CCAA, ll.lon, ll.lat) : null;
                    const pv = inSpain ? regionAt(PROV, ll.lon, ll.lat) : null;
                    setSelectedRegion(c || a || pv ? { c, a, pv } : null);
                }
            }
        }
        dragStart.current = null;
    };

    const centerOnMe = () => {
        if (lastPos) { setViewPersist({ lon: lastPos[1], lat: lastPos[0], z: Math.max(viewRef.current.z, 12) }); return; }
        if ('geolocation' in navigator) {
            navigator.geolocation.getCurrentPosition(
                (pos) => { addPoint(pos.coords.latitude, pos.coords.longitude, true); setViewPersist({ lon: pos.coords.longitude, lat: pos.coords.latitude, z: 13 }); },
                () => setToast(t('No se pudo obtener tu posicion')),
                { enableHighAccuracy: true, timeout: 15000 }
            );
        }
    };

    // v1.1: buscador de cimas, cimas cercanas y tarjeta para compartir
    const [peakQuery, setPeakQuery] = useState('');
    const normTxt = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const peakResults = useMemo(() => {
        const q = normTxt(peakQuery.trim());
        if (q.length < 2) return [];
        return allPeaks.filter((p) => normTxt(p[0]).includes(q)).sort((a, b) => b[3] - a[3]).slice(0, 50);
    }, [peakQuery, allPeaks]);
    const nearbyPeaks = useMemo(() => {
        if (!lastPos) return [] as { p: Peak; d: number }[];
        return allPeaks.map((p) => ({ p, d: distM(lastPos, [p[1], p[2]]) }))
            .filter((x) => x.d <= 100000)
            .sort((a, b) => a.d - b.d)
            .slice(0, 10);
    }, [lastPos, allPeaks]);
    const ccaaRanking = useMemo(() => {
        if (!progress.cells.length) return [] as { n: string; c: number[]; pct: number }[];
        return CCAA.map((rg) => ({ n: rg.n, c: rg.c, pct: Math.min(100, regionRevealedCells(rg, progress.cells) / regionTotalCells(rg) * 100) }))
            .filter((r) => r.pct >= 0.05)
            .sort((a, b) => b.pct - a.pct)
            .slice(0, 8);
    }, [progress.cells]);
    const showPeakOnMap = (p: Peak) => { setSelectedPeak(p); setSelectedRegion(null); setViewPersist({ lon: p[2], lat: p[1], z: 11 }); setTab('mapa'); };

    // v1.31: ver una aventura dibujada en el mapa (base de la vista publica de rutas)
    const showAdvOnMap = (a: Adventure) => {
        if (!a.track || a.track.length < 2) { setToast(t('Esta aventura no tiene track GPS')); return; }
        setFocusAdv(a); setSelectedRegion(null); setSelectedPeak(null); setImportBatch(null);
        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        for (const q of a.track) { if (q[0] < minLat) minLat = q[0]; if (q[0] > maxLat) maxLat = q[0]; if (q[1] < minLon) minLon = q[1]; if (q[1] > maxLon) maxLon = q[1]; }
        const w = wrapRef.current?.clientWidth || 800, h = wrapRef.current?.clientHeight || 500;
        const spanLon = Math.max(0.001, maxLon - minLon), spanLat = Math.max(0.001, maxLat - minLat);
        const zx = Math.log2((w * 0.7 * 360) / (256 * spanLon));
        const zy = Math.log2((h * 0.7 * 360) / (256 * spanLat * 1.4));
        setViewPersist({ lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2, z: Math.max(3, Math.min(15, Math.min(zx, zy))) });
        setTab('mapa');
    };
    const locateForNearby = () => {
        if (!('geolocation' in navigator)) { setToast(t('Tu navegador no soporta geolocalizacion')); return; }
        navigator.geolocation.getCurrentPosition(
            (pos) => { addPoint(pos.coords.latitude, pos.coords.longitude, true); setLastPos([pos.coords.latitude, pos.coords.longitude]); },
            () => setToast(t('No se pudo obtener tu posicion')),
            { enableHighAccuracy: true, timeout: 15000 }
        );
    };
    // v1.24: tarjeta PNG de un territorio concreto desde su ficha
    const shareRegionCard = async (rg: Region, level: string) => {
        try {
            const W = 1080, H = 1350;
            const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
            const g = cv.getContext('2d'); if (!g) return;
            g.fillStyle = '#0b1017'; g.fillRect(0, 0, W, H);
            const avImg = avatar ? await new Promise<HTMLImageElement | null>((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = avatar; }) : null;
            g.save();
            g.beginPath(); g.arc(124, 112, 64, 0, Math.PI * 2); g.closePath(); g.clip();
            if (avImg) g.drawImage(avImg, 60, 48, 128, 128);
            else { g.fillStyle = '#14755f'; g.fillRect(60, 48, 128, 128); g.fillStyle = '#fff'; g.font = '700 64px -apple-system, Segoe UI, Roboto, sans-serif'; g.textAlign = 'center'; g.fillText((prefs.nombre.trim()[0] || '?').toUpperCase(), 124, 134); g.textAlign = 'left'; }
            g.restore();
            g.strokeStyle = 'rgba(45,200,170,0.8)'; g.lineWidth = 4;
            g.beginPath(); g.arc(124, 112, 64, 0, Math.PI * 2); g.stroke();
            g.fillStyle = '#e6edf3'; g.font = '800 62px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText('TerraUnlock', 224, 110);
            g.fillStyle = '#2dc8aa'; g.font = '700 34px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(level, 224, 170);
            const rev = regionRevealedCells(rg, progress.cells);
            const pct = Math.min(100, rev / regionTotalCells(rg) * 100);
            const unlocked = (level === t('Provincia') && progress.prov.includes(rg.n)) || (level === t('Comunidad') && progress.ccaa.includes(rg.n)) || (level === t('Pais') && progress.countries.includes(rg.n));
            // nombre grande, reduciendo la fuente si no cabe
            let fs = 110;
            g.font = '800 ' + fs + 'px -apple-system, Segoe UI, Roboto, sans-serif';
            while (fs > 44 && g.measureText(rg.n).width > W - 120) { fs -= 8; g.font = '800 ' + fs + 'px -apple-system, Segoe UI, Roboto, sans-serif'; }
            g.fillStyle = '#e6edf3';
            g.fillText(rg.n, 60, 400);
            g.fillStyle = unlocked ? '#2dc8aa' : '#9fb0c0'; g.font = '700 42px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(unlocked ? t('Conquistada') : t('{pct}% revelado', { pct: dec(pct) }), 60, 480);
            // barra de revelado
            g.fillStyle = '#111927'; g.beginPath(); g.roundRect(60, 540, W - 120, 44, 22); g.fill();
            if (pct > 0) { g.fillStyle = '#2dc8aa'; g.beginPath(); g.roundRect(60, 540, Math.max(44, (W - 120) * pct / 100), 44, 22); g.fill(); }
            g.fillStyle = unlocked ? '#0b1017' : '#e6edf3'; g.font = '800 30px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(dec(pct) + '%', 84, 573);
            // cajas de stats
            const inside = peaksInRegion(rg, allPeaks);
            const won = inside.filter((p) => progress.peaks.includes(peakId(p))).length;
            let subLabel = '', subVal = '';
            if (level === t('Comunidad')) {
                const provs = PROV.filter((p) => provToCcaa(p) === rg.n);
                subLabel = t('PROVINCIAS'); subVal = provs.filter((p) => progress.prov.includes(p.n)).length + '/' + provs.length;
            } else if (level === t('Pais') && rg.n === 'España') {
                subLabel = t('COMUNIDADES'); subVal = progress.ccaa.length + '/' + CCAA.length;
            }
            const boxes: [string, string][] = [[t('CIMAS'), won + '/' + inside.length]];
            if (subLabel) boxes.unshift([subLabel, subVal]);
            boxes.unshift([t('REVELADO'), dec(pct) + '%']);
            const bw = (W - 120 - (boxes.length - 1) * 18) / boxes.length;
            boxes.forEach(([lab, val], i) => {
                const bx = 60 + i * (bw + 18);
                g.fillStyle = '#111927'; g.beginPath(); g.roundRect(bx, 660, bw, 122, 16); g.fill();
                g.strokeStyle = '#1c2733'; g.lineWidth = 2; g.stroke();
                g.fillStyle = '#5c7080'; g.font = '700 24px -apple-system, Segoe UI, Roboto, sans-serif';
                g.fillText(lab, bx + 24, 704);
                g.fillStyle = '#e6edf3'; g.font = '800 44px -apple-system, Segoe UI, Roboto, sans-serif';
                g.fillText(val, bx + 24, 760);
            });
            // v1.25: silueta del territorio con lo revelado en teal
            if (rg.r && rg.r.length) {
                const px = 60, py = 830, pw = W - 120, ph = 340, pad = 24;
                const spanLo = Math.max(1e-9, rg.b[2] - rg.b[0]), spanLa = Math.max(1e-9, rg.b[3] - rg.b[1]);
                const sc = Math.min((pw - pad * 2) / spanLo, (ph - pad * 2) / spanLa);
                const offX = px + pad + ((pw - pad * 2) - spanLo * sc) / 2;
                const offY = py + pad + ((ph - pad * 2) - spanLa * sc) / 2;
                const X = (lo: number) => offX + (lo - rg.b[0]) * sc;
                const Y = (la: number) => py + ph - pad - (((ph - pad * 2) - spanLa * sc) / 2) - (la - rg.b[1]) * sc;
                g.fillStyle = '#0d1420'; g.beginPath(); g.roundRect(px, py, pw, ph, 16); g.fill();
                g.strokeStyle = '#1c2733'; g.lineWidth = 2; g.stroke();
                g.save();
                g.beginPath(); g.roundRect(px, py, pw, ph, 16); g.clip();
                // relleno base de la region
                g.beginPath();
                for (const ring of rg.r) {
                    for (let i2 = 0; i2 < ring.length; i2 += 2) { const x = X(ring[i2]), y = Y(ring[i2 + 1]); if (i2 === 0) g.moveTo(x, y); else g.lineTo(x, y); }
                    g.closePath();
                }
                g.fillStyle = '#16222f'; g.fill();
                // celdas reveladas dentro de la region
                g.fillStyle = 'rgba(45,200,170,0.75)';
                const cellPx = Math.max(2, CELL * sc);
                for (const ck of progress.cells) {
                    const ci = ck.indexOf(',');
                    const cla = +ck.slice(0, ci) * CELL, clo = +ck.slice(ci + 1) * CELL;
                    if (clo < rg.b[0] || clo > rg.b[2] || cla < rg.b[1] || cla > rg.b[3]) continue;
                    if (!pip(clo, cla, rg.r)) continue;
                    g.fillRect(X(clo - CELL / 2), Y(cla + CELL / 2), cellPx, cellPx);
                }
                // contorno
                g.beginPath();
                for (const ring of rg.r) {
                    for (let i2 = 0; i2 < ring.length; i2 += 2) { const x = X(ring[i2]), y = Y(ring[i2 + 1]); if (i2 === 0) g.moveTo(x, y); else g.lineTo(x, y); }
                    g.closePath();
                }
                g.strokeStyle = '#2dc8aa'; g.lineWidth = 3; g.stroke();
                g.restore();
            }
            g.fillStyle = '#5c7080'; g.font = '500 27px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(t('Cuanto conoces de {n}? davidburgoscarpeno.github.io/TerraUnlock', { n: rg.n }), 60, H - 60);
            const blob: Blob | null = await new Promise((res) => cv.toBlob(res, 'image/png'));
            if (!blob) { setToast(t('No se pudo generar la tarjeta')); return; }
            await shareBlob(blob, 'terraunlock-' + rg.n.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.png', 'TerraUnlock: ' + rg.n);
        } catch { setToast(t('No se pudo compartir la tarjeta')); }
    };
    const shareCard = async () => {
        try {
            const W = 1080, H = 1350;
            const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
            const g = cv.getContext('2d'); if (!g) return;
            g.fillStyle = '#0b1017'; g.fillRect(0, 0, W, H);
            const mapX = 60, mapY = 290, mapW = W - 120, mapH = H - 640;
            const px = (lon: number) => mapX + (lon + 180) / 360 * mapW;
            const py = (lat: number) => mapY + (80 - lat) / 160 * mapH;
            g.lineWidth = 1;
            for (const rg of COUNTRIES) {
                const won = progress.countries.includes(rg.n);
                for (const ring of rg.r) {
                    g.beginPath();
                    for (let i = 0; i < ring.length; i += 2) { const x = px(ring[i]), y = py(ring[i + 1]); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); }
                    g.closePath();
                    if (won) { g.fillStyle = 'rgba(45,200,170,0.18)'; g.fill(); }
                    g.strokeStyle = 'rgba(70,95,110,0.55)'; g.stroke();
                }
            }
            g.fillStyle = '#2dc8aa';
            for (const ck of progress.cells) {
                const i = ck.indexOf(',');
                const lat = +ck.slice(0, i) * CELL, lon = +ck.slice(i + 1) * CELL;
                g.fillRect(px(lon) - 2.5, py(lat) - 2.5, 5, 5);
            }
            // v1.5: avatar (foto o inicial) a la izquierda del titulo
            const avImg = avatar ? await new Promise<HTMLImageElement | null>((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = avatar; }) : null;
            g.save();
            g.beginPath(); g.arc(124, 112, 64, 0, Math.PI * 2); g.closePath(); g.clip();
            if (avImg) g.drawImage(avImg, 60, 48, 128, 128);
            else { g.fillStyle = '#14755f'; g.fillRect(60, 48, 128, 128); g.fillStyle = '#fff'; g.font = '700 64px -apple-system, Segoe UI, Roboto, sans-serif'; g.textAlign = 'center'; g.fillText((prefs.nombre.trim()[0] || '?').toUpperCase(), 124, 134); g.textAlign = 'left'; }
            g.restore();
            g.strokeStyle = 'rgba(45,200,170,0.8)'; g.lineWidth = 4;
            g.beginPath(); g.arc(124, 112, 64, 0, Math.PI * 2); g.stroke();
            g.fillStyle = '#e6edf3'; g.font = '800 62px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText('TerraUnlock', 224, 110);
            if (prefs.nombre.trim()) { g.fillStyle = '#2dc8aa'; g.font = '700 34px -apple-system, Segoe UI, Roboto, sans-serif'; g.fillText(t('El mundo de {nombre}', { nombre: prefs.nombre.trim() }), 224, 170); }
            g.fillStyle = '#9fb0c0'; g.font = '600 30px -apple-system, Segoe UI, Roboto, sans-serif';
            const st = t('~{km2} revelados - {c}/177 paises - {a}/19 CCAA - {k} cimas', { km2: fmtAreaShort(progress.cells.length * 1.1), c: progress.countries.length, a: progress.ccaa.length, k: progress.peaks.length }).replace(/ - /g, '   -   ');
            g.fillText(st, 60, 228);
            g.fillStyle = '#5c7080'; g.font = '600 26px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(t('Cuantos paises has pisado? davidburgoscarpeno.github.io/TerraUnlock'), 60, H - 60);
            const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/png'));
            if (!blob) { setToast(t('No se pudo generar la tarjeta')); return; }
            const file = new File([blob], 'terraunlock.png', { type: 'image/png' });
            const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean; share?: (d: { files: File[]; title: string }) => Promise<void> };
            if (nav.canShare && nav.share && nav.canShare({ files: [file] })) {
                await nav.share({ files: [file], title: 'TerraUnlock' });
            } else {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'terraunlock.png';
                a.click();
                setToast(t('Tarjeta descargada'));
            }
        } catch (e) {
            if (e instanceof Error && e.name === 'AbortError') return;
            setToast(t('No se pudo compartir la tarjeta'));
        }
    };

    // v1.10: tarjeta semanal (pique): lo conquistado esta semana + estado del objetivo
    const shareBlob = async (blob: Blob, filename: string, title: string) => {
        const file = new File([blob], filename, { type: 'image/png' });
        const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean; share?: (d: { files: File[]; title: string }) => Promise<void> };
        if (nav.canShare && nav.share && nav.canShare({ files: [file] })) {
            await nav.share({ files: [file], title });
        } else {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.click();
            setToast(t('Tarjeta descargada'));
        }
    };
    // v1.80: tarjeta de logro para compartir (antes Compartir en un logro compartia la tarjeta del mapa)
    const shareAchievementCard = async (a: Achievement) => {
        try {
            const W = 1080, H = 1080;
            const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
            const g = cv.getContext('2d'); if (!g) return;
            g.fillStyle = '#0b1017'; g.fillRect(0, 0, W, H);
            g.beginPath(); g.arc(W / 2, 300, 130, 0, Math.PI * 2);
            g.fillStyle = 'rgba(45,200,170,0.16)'; g.fill();
            g.lineWidth = 6; g.strokeStyle = '#2dc8aa'; g.stroke();
            g.fillStyle = '#2dc8aa'; g.font = '600 150px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText('\u2605', W / 2, 312);
            g.fillStyle = 'rgba(230,240,244,0.65)'; g.font = '600 34px system-ui, sans-serif';
            g.fillText(t('Logro desbloqueado').toUpperCase(), W / 2, 520);
            g.fillStyle = '#e6f0f4'; g.font = '700 64px system-ui, sans-serif';
            g.fillText(t(a.title), W / 2, 620);
            g.fillStyle = 'rgba(230,240,244,0.75)'; g.font = '400 34px system-ui, sans-serif';
            g.fillText(t(a.hint), W / 2, 690);
            const at = achUnlocked[a.id];
            if (at) { g.fillStyle = 'rgba(45,200,170,0.9)'; g.font = '500 32px system-ui, sans-serif'; g.fillText(new Date(at).toLocaleDateString(dateLocale()), W / 2, 770); }
            const who = prefs.nombre.trim();
            g.fillStyle = 'rgba(230,240,244,0.55)'; g.font = '500 30px system-ui, sans-serif';
            g.fillText(who ? who + ' - TerraUnlock' : 'TerraUnlock', W / 2, 950);
            const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/png'));
            if (blob) await shareBlob(blob, 'terraunlock-logro.png', t(a.title));
        } catch { setToast(t('No se pudo crear la tarjeta')); }
    };
    const shareWeekCard = async (prev?: unknown) => {
        try {
            // v1.66: prev === true -> tarjeta de la SEMANA PASADA (se usa desde el resumen semanal)
            let terrC: string[], terrA: string[], terrP: string[], newPeaks: Peak[], kmW = 0;
            if (prev === true) {
                const now0 = new Date();
                const mon0 = new Date(now0.getFullYear(), now0.getMonth(), now0.getDate() - ((now0.getDay() + 6) % 7)).getTime();
                const prevMon0 = mon0 - 7 * 86400000;
                const list = adventures.filter((a) => { const t0 = new Date(a.start).getTime(); return t0 >= prevMon0 && t0 < mon0; });
                kmW = list.reduce((n, a) => n + a.km, 0);
                terrC = [...new Set(list.flatMap((a) => a.countries))];
                terrA = [...new Set(list.flatMap((a) => a.ccaa))];
                terrP = [...new Set(list.flatMap((a) => a.prov))];
                newPeaks = [...new Set(list.flatMap((a) => a.peaks))].map((id) => peakById.get(id)).filter((p): p is Peak => !!p).sort((a, b) => b[3] - a[3]);
            } else {
                terrC = progress.countries.filter((n) => !weekly.countries0.includes(n));
                terrA = progress.ccaa.filter((n) => !weekly.ccaa0.includes(n));
                terrP = progress.prov.filter((n) => !weekly.prov0.includes(n));
                newPeaks = progress.peaks.filter((id) => !weekly.peaks0.includes(id)).map((id) => peakById.get(id)).filter((p): p is Peak => !!p).sort((a, b) => b[3] - a[3]);
            }
            const terrN = terrC.length + terrA.length + terrP.length;
            const done = terrN >= WEEK_TERR || newPeaks.length >= WEEK_PEAK;
            const W = 1080, H = 1350;
            const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
            const g = cv.getContext('2d'); if (!g) return;
            g.fillStyle = '#0b1017'; g.fillRect(0, 0, W, H);
            // avatar + cabecera (mismo bloque que la tarjeta general)
            const avImg = avatar ? await new Promise<HTMLImageElement | null>((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = avatar; }) : null;
            g.save();
            g.beginPath(); g.arc(124, 112, 64, 0, Math.PI * 2); g.closePath(); g.clip();
            if (avImg) g.drawImage(avImg, 60, 48, 128, 128);
            else { g.fillStyle = '#14755f'; g.fillRect(60, 48, 128, 128); g.fillStyle = '#fff'; g.font = '700 64px -apple-system, Segoe UI, Roboto, sans-serif'; g.textAlign = 'center'; g.fillText((prefs.nombre.trim()[0] || '?').toUpperCase(), 124, 134); g.textAlign = 'left'; }
            g.restore();
            g.strokeStyle = 'rgba(45,200,170,0.8)'; g.lineWidth = 4;
            g.beginPath(); g.arc(124, 112, 64, 0, Math.PI * 2); g.stroke();
            g.fillStyle = '#e6edf3'; g.font = '800 62px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText('TerraUnlock', 224, 110);
            g.fillStyle = '#2dc8aa'; g.font = '700 34px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(prefs.nombre.trim() ? t('La semana de {nombre}', { nombre: prefs.nombre.trim() }) : t('Mi semana de conquista'), 224, 170);
            // rango de la semana (lunes a domingo)
            const now = new Date();
            const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
            if (prev === true) mon.setDate(mon.getDate() - 7);
            const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
            const rango = mon.getMonth() === sun.getMonth()
                ? t('del {d1} de {m1} al {d2} de {m2} de {y}', { d1: mon.getDate(), d2: sun.getDate(), m1: monthName(sun.getMonth()), m2: monthName(sun.getMonth()), y: sun.getFullYear() })
                : t('del {d1} de {m1} al {d2} de {m2}', { d1: mon.getDate(), m1: monthName(mon.getMonth()), d2: sun.getDate(), m2: monthName(sun.getMonth()) });
            g.fillStyle = '#9fb0c0'; g.font = '600 30px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(t('Semana {rango}', { rango }), 60, 250);
            // numeros grandes
            g.fillStyle = '#2dc8aa'; g.font = '800 130px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText('+' + terrN, 60, 420);
            g.font = '700 40px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(terrN === 1 ? t('territorio nuevo') : t('territorios nuevos'), 60, 480);
            g.fillStyle = '#e8cd6e'; g.font = '800 130px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText('+' + newPeaks.length, 560, 420);
            g.font = '700 40px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(newPeaks.length === 1 ? t('cima conquistada') : t('cimas conquistadas'), 560, 480);
            // v1.32: listado con siluetas de los territorios nuevos
            const FONT = '-apple-system, Segoe UI, Roboto, sans-serif';
            const newRegsCard: { rg: Region; lvl: string; stroke: string }[] = [];
            for (const n of terrC) { const rg = COUNTRIES.find((r) => r.n === n); if (rg) newRegsCard.push({ rg, lvl: t('Pais'), stroke: '#7ee0c8' }); }
            for (const n of terrA) { const rg = CCAA.find((r) => r.n === n); if (rg) newRegsCard.push({ rg, lvl: t('Comunidad'), stroke: '#e8cd6e' }); }
            for (const n of terrP) { const rg = PROV.find((r) => r.n === n); if (rg) newRegsCard.push({ rg, lvl: t('Provincia'), stroke: '#8fb8d8' }); }
            let cy = 540;
            if (newRegsCard.length && cy <= 1060) {
                g.fillStyle = '#9fb0c0'; g.font = '700 28px ' + FONT;
                g.fillText(t('TERRITORIOS NUEVOS'), 60, cy + 34);
                cy += 56;
                const shown = newRegsCard.slice(0, 6);
                const tw = (W - 120 - 2 * 18) / 3, th = 240;
                shown.forEach(({ rg, lvl, stroke }, i) => {
                    const col = i % 3, row = Math.floor(i / 3);
                    const tx = 60 + col * (tw + 18), ty = cy + row * (th + 16);
                    g.fillStyle = '#0d1420'; g.beginPath(); g.roundRect(tx, ty, tw, th, 16); g.fill();
                    g.strokeStyle = '#1c2733'; g.lineWidth = 2; g.stroke();
                    drawRegionShape(g, rg, tx + 12, ty + 12, tw - 24, th - 82, 8, 'rgba(45,200,170,0.10)', stroke, 2.5);
                    let fs2 = 30;
                    g.font = '700 ' + fs2 + 'px ' + FONT;
                    while (fs2 > 17 && g.measureText(rg.n).width > tw - 36) { fs2 -= 3; g.font = '700 ' + fs2 + 'px ' + FONT; }
                    g.fillStyle = '#e6edf3'; g.textAlign = 'center';
                    g.fillText(rg.n, tx + tw / 2, ty + th - 40);
                    g.fillStyle = stroke; g.font = '600 20px ' + FONT;
                    g.fillText(lvl, tx + tw / 2, ty + th - 14);
                    g.textAlign = 'left';
                });
                cy += Math.ceil(shown.length / 3) * (th + 16) + 8;
                if (newRegsCard.length > 6) { g.fillStyle = '#5c7080'; g.font = '600 28px ' + FONT; g.fillText(t('y {n} mas', { n: newRegsCard.length - 6 }), 60, cy + 22); cy += 48; }
            }
            if (newPeaks.length && cy <= 1060) {
                g.fillStyle = '#9fb0c0'; g.font = '700 28px -apple-system, Segoe UI, Roboto, sans-serif';
                g.fillText(t('CIMAS'), 60, cy + 34);
                cy += 56;
                g.font = '600 31px -apple-system, Segoe UI, Roboto, sans-serif';
                for (const p of newPeaks.slice(0, 6)) {
                    g.fillStyle = '#e6edf3'; g.fillText(p[0], 60, cy + 20);
                    g.fillStyle = '#e8cd6e'; g.textAlign = 'right'; g.fillText(p[3] + ' m', W - 60, cy + 20); g.textAlign = 'left';
                    cy += 48;
                }
                if (newPeaks.length > 6) { g.fillStyle = '#5c7080'; g.fillText(t('y {n} mas', { n: newPeaks.length - 6 }), 60, cy + 20); cy += 48; }
                cy += 10;
            }
            if (!terrN && !newPeaks.length) {
                g.fillStyle = '#9fb0c0'; g.font = '600 34px -apple-system, Segoe UI, Roboto, sans-serif';
                g.fillText(prev === true ? t('{km} en movimiento - semana sin conquistas nuevas', { km: fmtDist(kmW) }) : t('Semana tranquila... por ahora. Va a durar poco.'), 60, cy + 40);
                cy += 80;
            }
            // v1.67: progreso del objetivo de distancia semanal (si esta activado en Ajustes)
            if ((prefs.weekKm || 0) > 0 && cy + 84 <= 1140) {
                const goal = prefs.weekKm || 0;
                const cur = prev === true ? kmW : weekKmCmp.cur;
                g.fillStyle = '#9fb0c0'; g.font = '700 28px ' + FONT;
                g.fillText(t('OBJETIVO DE DISTANCIA'), 60, cy + 30);
                g.fillStyle = '#e6edf3'; g.font = '600 26px ' + FONT;
                g.textAlign = 'right'; g.fillText(fmtDist(Math.min(cur, goal)) + ' / ' + fmtDist(goal), W - 60, cy + 30); g.textAlign = 'left';
                g.fillStyle = '#101823'; g.beginPath(); g.roundRect(60, cy + 44, W - 120, 16, 8); g.fill();
                g.fillStyle = cur >= goal ? '#2dc8aa' : '#8fb8d8'; g.beginPath(); g.roundRect(60, cy + 44, Math.max(16, (W - 120) * Math.min(1, cur / goal)), 16, 8); g.fill();
                cy += 84;
            }
            // estado del objetivo
            g.fillStyle = done ? '#123a31' : '#101823';
            g.fillRect(60, 1150, W - 120, 84);
            g.fillStyle = done ? '#2dc8aa' : '#9fb0c0'; g.font = '700 32px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(done ? t('Objetivo semanal: CUMPLIDO') : t('Objetivo semanal: {t}/{tt} territorios - {p}/{pp} cimas', { t: Math.min(terrN, WEEK_TERR), tt: WEEK_TERR, p: Math.min(newPeaks.length, WEEK_PEAK), pp: WEEK_PEAK }), 84, 1204);
            g.fillStyle = '#5c7080'; g.font = '600 26px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(t('Tu que has conquistado esta semana? davidburgoscarpeno.github.io/TerraUnlock'), 60, H - 42);
            const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/png'));
            if (!blob) { setToast(t('No se pudo generar la tarjeta')); return; }
            await shareBlob(blob, 'terraunlock-semana.png', t('TerraUnlock: mi semana'));
        } catch (e) {
            if (e instanceof Error && e.name === 'AbortError') return;
            setToast(t('No se pudo compartir la tarjeta'));
        }
    };

    // v1.75: tarjeta PNG del calendario de actividad (heatmap de 20 semanas)
    const shareHeatCard = async () => {
        try {
            // mismos datos que el calendario de Progreso, siempre con TODOS los deportes
            const days = new Map<string, number>();
            for (const a of adventures) {
                const d = new Date(a.start);
                if (!isFinite(d.getTime())) continue;
                const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
                days.set(k, (days.get(k) || 0) + a.km);
            }
            const today = new Date(); today.setHours(0, 0, 0, 0);
            const dow = (today.getDay() + 6) % 7;
            const end = new Date(today); end.setDate(end.getDate() + (6 - dow));
            const start = new Date(end); start.setDate(start.getDate() - 20 * 7 + 1);
            const weeks: ({ k: string; km: number } | null)[][] = [];
            let totalKm = 0, activeDays = 0, bestKm = 0, bestK = '';
            const cur = new Date(start);
            while (cur <= end) {
                const col: ({ k: string; km: number } | null)[] = [];
                for (let i = 0; i < 7; i++) {
                    if (cur > today) { col.push(null); cur.setDate(cur.getDate() + 1); continue; }
                    const k = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0');
                    const km = days.get(k) || 0;
                    if (km > 0) { totalKm += km; activeDays += 1; if (km > bestKm) { bestKm = km; bestK = k; } }
                    col.push({ k, km });
                    cur.setDate(cur.getDate() + 1);
                }
                weeks.push(col);
            }
            const W = 1080, H = 1350;
            const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
            const g = cv.getContext('2d'); if (!g) return;
            g.fillStyle = '#0b1017'; g.fillRect(0, 0, W, H);
            const avImg = avatar ? await new Promise<HTMLImageElement | null>((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = avatar; }) : null;
            g.save();
            g.beginPath(); g.arc(124, 112, 64, 0, Math.PI * 2); g.closePath(); g.clip();
            if (avImg) g.drawImage(avImg, 60, 48, 128, 128);
            else { g.fillStyle = '#14755f'; g.fillRect(60, 48, 128, 128); g.fillStyle = '#fff'; g.font = '700 64px -apple-system, Segoe UI, Roboto, sans-serif'; g.textAlign = 'center'; g.fillText((prefs.nombre.trim()[0] || '?').toUpperCase(), 124, 134); g.textAlign = 'left'; }
            g.restore();
            g.strokeStyle = 'rgba(45,200,170,0.8)'; g.lineWidth = 4;
            g.beginPath(); g.arc(124, 112, 64, 0, Math.PI * 2); g.stroke();
            g.fillStyle = '#e6edf3'; g.font = '800 62px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText('TerraUnlock', 224, 110);
            g.fillStyle = '#2dc8aa'; g.font = '700 34px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(prefs.nombre.trim() ? t('La actividad de {nombre}', { nombre: prefs.nombre.trim() }) : t('Mi actividad de conquista'), 224, 170);
            g.fillStyle = '#9fb0c0'; g.font = '600 30px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(t('Ultimas 20 semanas'), 60, 250);
            // numeros grandes
            g.fillStyle = '#2dc8aa'; g.font = '800 110px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(fmtDist(totalKm), 60, 400);
            g.font = '700 38px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(t('km recorridos'), 60, 456);
            g.fillStyle = '#e8cd6e'; g.font = '800 110px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(String(activeDays), 560, 400);
            g.font = '700 38px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(activeDays === 1 ? t('dia activo') : t('dias activos'), 560, 456);
            // grid del heatmap
            const cell = 38, gap = 10, step = cell + gap;
            const gx = 60, gy = 520;
            const LV = ['#161c26', 'rgba(45,200,170,0.30)', 'rgba(45,200,170,0.60)', '#2dc8aa'];
            weeks.forEach((col, wi) => {
                col.forEach((d, di) => {
                    if (!d) return;
                    const lv = d.km <= 0 ? 0 : d.km < 5 ? 1 : d.km < 15 ? 2 : 3;
                    g.fillStyle = LV[lv];
                    g.beginPath(); g.roundRect(gx + wi * step, gy + di * step, cell, cell, 7); g.fill();
                });
            });
            // etiquetas de mes
            g.fillStyle = '#5c7080'; g.font = '600 22px -apple-system, Segoe UI, Roboto, sans-serif';
            let prevM = -1;
            weeks.forEach((col, wi) => {
                const first = col.find((d) => d !== null);
                if (!first) return;
                const m = parseInt(first.k.slice(5, 7), 10) - 1;
                if (m === prevM) return;
                prevM = m;
                g.fillText(monthName(m).slice(0, 3), gx + wi * step, gy + 7 * step + 26);
            });
            // mejor dia
            let cy2 = gy + 7 * step + 90;
            g.fillStyle = '#9fb0c0'; g.font = '700 28px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(t('MEJOR DIA'), 60, cy2 + 30);
            if (bestK) {
                const bd = new Date(bestK + 'T12:00:00');
                g.fillStyle = '#e6edf3'; g.font = '600 34px -apple-system, Segoe UI, Roboto, sans-serif';
                g.fillText(fmtDist(bestKm) + ' - ' + bd.toLocaleDateString(dateLocale()), 60, cy2 + 76);
            } else {
                g.fillStyle = '#e6edf3'; g.font = '600 34px -apple-system, Segoe UI, Roboto, sans-serif';
                g.fillText(t('Aun sin actividad: el primer paso es el que cuenta.'), 60, cy2 + 76);
            }
            g.fillStyle = '#5c7080'; g.font = '600 26px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(t('Y tu? Empieza a conquistar: davidburgoscarpeno.github.io/TerraUnlock'), 60, H - 42);
            const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/png'));
            if (!blob) { setToast(t('No se pudo generar la tarjeta')); return; }
            await shareBlob(blob, 'terraunlock-actividad.png', t('TerraUnlock: mi actividad'));
        } catch (e) {
            if (e instanceof Error && e.name === 'AbortError') return;
            setToast(t('No se pudo compartir la tarjeta'));
        }
    };

    // v1.33: tarjeta PNG del resumen mensual (km, territorios con silueta, cimas)
    const shareMonthCard = async (prev?: unknown) => {
        try {
            // v1.68: prev === true -> tarjeta del MES PASADO (se usa desde el resumen mensual)
            const now = new Date();
            const mStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
            const rangeStart = prev === true ? new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime() : mStart;
            const rangeEnd = prev === true ? mStart : now.getTime();
            const list = adventures.filter((a) => { const t0 = new Date(a.start).getTime(); return t0 >= rangeStart && t0 <= rangeEnd; });
            const km = list.reduce((n, a) => n + a.km, 0);
            const terrC = [...new Set(list.flatMap((a) => a.countries))];
            const terrA = [...new Set(list.flatMap((a) => a.ccaa))];
            const terrP = [...new Set(list.flatMap((a) => a.prov))];
            const peakIds = [...new Set(list.flatMap((a) => a.peaks))];
            const mPeaks = peakIds.map((id) => peakById.get(id)).filter((p): p is Peak => !!p).sort((a, b) => b[3] - a[3]);
            const terrN = terrC.length + terrA.length + terrP.length;
            const W = 1080, H = 1350;
            const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
            const g = cv.getContext('2d'); if (!g) return;
            const FONT = '-apple-system, Segoe UI, Roboto, sans-serif';
            g.fillStyle = '#0b1017'; g.fillRect(0, 0, W, H);
            const avImg = avatar ? await new Promise<HTMLImageElement | null>((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = avatar; }) : null;
            g.save();
            g.beginPath(); g.arc(124, 112, 64, 0, Math.PI * 2); g.closePath(); g.clip();
            if (avImg) g.drawImage(avImg, 60, 48, 128, 128);
            else { g.fillStyle = '#14755f'; g.fillRect(60, 48, 128, 128); g.fillStyle = '#fff'; g.font = '700 64px ' + FONT; g.textAlign = 'center'; g.fillText((prefs.nombre.trim()[0] || '?').toUpperCase(), 124, 134); g.textAlign = 'left'; }
            g.restore();
            g.strokeStyle = 'rgba(45,200,170,0.8)'; g.lineWidth = 4;
            g.beginPath(); g.arc(124, 112, 64, 0, Math.PI * 2); g.stroke();
            g.fillStyle = '#e6edf3'; g.font = '800 62px ' + FONT;
            g.fillText('TerraUnlock', 224, 110);
            g.fillStyle = '#2dc8aa'; g.font = '700 34px ' + FONT;
            g.fillText(prefs.nombre.trim() ? t('El mes de {nombre}', { nombre: prefs.nombre.trim() }) : t('Mi mes de conquista'), 224, 170);
            // titulo del mes
            const mesTitulo = (prev === true ? monthName(new Date(now.getFullYear(), now.getMonth() - 1, 1).getMonth()) + ' ' + t('de') + ' ' + new Date(now.getFullYear(), now.getMonth() - 1, 1).getFullYear() : monthName(now.getMonth()) + ' ' + t('de') + ' ' + now.getFullYear());
            g.fillStyle = '#e6edf3'; g.font = '800 58px ' + FONT;
            g.fillText(mesTitulo.charAt(0).toUpperCase() + mesTitulo.slice(1), 60, 268);
            // numeros grandes en dos filas
            const big = (val: string, lab: string, x: number, y: number, col: string) => {
                g.fillStyle = col; g.font = '800 110px ' + FONT; g.fillText(val, x, y);
                g.font = '700 38px ' + FONT; g.fillText(lab, x, y + 58);
            };
            big(dec(km, 1), t('km recorridos'), 60, 430, '#2dc8aa');
            big('+' + terrN, terrN === 1 ? t('territorio nuevo') : t('territorios nuevos'), 560, 430, '#2dc8aa');
            big(String(list.length), list.length === 1 ? t('aventura') : t('aventuras'), 60, 640, '#e6edf3');
            big('+' + mPeaks.length, mPeaks.length === 1 ? t('cima conquistada') : t('cimas conquistadas'), 560, 640, '#e8cd6e');
            // siluetas de territorios del mes
            let cy = 730;
            const newRegsCard: { rg: Region; lvl: string; stroke: string }[] = [];
            for (const n of terrC) { const rg = COUNTRIES.find((r) => r.n === n); if (rg) newRegsCard.push({ rg, lvl: t('Pais'), stroke: '#7ee0c8' }); }
            for (const n of terrA) { const rg = CCAA.find((r) => r.n === n); if (rg) newRegsCard.push({ rg, lvl: t('Comunidad'), stroke: '#e8cd6e' }); }
            for (const n of terrP) { const rg = PROV.find((r) => r.n === n); if (rg) newRegsCard.push({ rg, lvl: t('Provincia'), stroke: '#8fb8d8' }); }
            if (newRegsCard.length) {
                g.fillStyle = '#9fb0c0'; g.font = '700 28px ' + FONT;
                g.fillText(t('TERRITORIOS NUEVOS'), 60, cy + 30);
                cy += 48;
                const shown = newRegsCard.slice(0, 6);
                const tw = (W - 120 - 2 * 18) / 3, th = 200;
                shown.forEach(({ rg, lvl, stroke }, i) => {
                    const col = i % 3, row = Math.floor(i / 3);
                    const tx = 60 + col * (tw + 18), ty = cy + row * (th + 14);
                    g.fillStyle = '#0d1420'; g.beginPath(); g.roundRect(tx, ty, tw, th, 16); g.fill();
                    g.strokeStyle = '#1c2733'; g.lineWidth = 2; g.stroke();
                    drawRegionShape(g, rg, tx + 12, ty + 10, tw - 24, th - 72, 6, 'rgba(45,200,170,0.10)', stroke, 2.5);
                    let fs2 = 28;
                    g.font = '700 ' + fs2 + 'px ' + FONT;
                    while (fs2 > 16 && g.measureText(rg.n).width > tw - 36) { fs2 -= 3; g.font = '700 ' + fs2 + 'px ' + FONT; }
                    g.fillStyle = '#e6edf3'; g.textAlign = 'center';
                    g.fillText(rg.n, tx + tw / 2, ty + th - 34);
                    g.fillStyle = stroke; g.font = '600 19px ' + FONT;
                    g.fillText(lvl, tx + tw / 2, ty + th - 11);
                    g.textAlign = 'left';
                });
                cy += Math.ceil(shown.length / 3) * (th + 14) + 6;
                if (newRegsCard.length > 6) { g.fillStyle = '#5c7080'; g.font = '600 26px ' + FONT; g.fillText(t('y {n} mas', { n: newRegsCard.length - 6 }), 60, cy + 20); cy += 42; }
            }
            // cimas del mes (solo si cabe comodo)
            if (mPeaks.length && cy <= 1060) {
                g.fillStyle = '#9fb0c0'; g.font = '700 28px ' + FONT;
                g.fillText(t('CIMAS'), 60, cy + 30);
                cy += 50;
                g.font = '600 31px ' + FONT;
                for (const p of mPeaks.slice(0, 4)) {
                    g.fillStyle = '#e6edf3'; g.fillText(p[0], 60, cy + 20);
                    g.fillStyle = '#e8cd6e'; g.textAlign = 'right'; g.fillText(p[3] + ' m', W - 60, cy + 20); g.textAlign = 'left';
                    cy += 46;
                }
                if (mPeaks.length > 4) { g.fillStyle = '#5c7080'; g.fillText(t('y {n} mas', { n: mPeaks.length - 4 }), 60, cy + 20); }
            }
            if (!list.length) {
                g.fillStyle = '#9fb0c0'; g.font = '600 34px ' + FONT;
                g.fillText(t('Mes tranquilo... por ahora. Va a durar poco.'), 60, cy + 40);
            }
            g.fillStyle = '#5c7080'; g.font = '600 26px ' + FONT;
            g.fillText(t('Tu que has conquistado este mes? davidburgoscarpeno.github.io/TerraUnlock'), 60, H - 42);
            const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/png'));
            if (!blob) { setToast(t('No se pudo generar la tarjeta')); return; }
            await shareBlob(blob, 'terraunlock-mes.png', t('TerraUnlock: mi mes'));
        } catch (e) {
            if (e instanceof Error && e.name === 'AbortError') return;
            setToast(t('No se pudo compartir la tarjeta'));
        }
    };

    // v1.51: tarjeta compartible "mi ano" (cierra el trio semana/mes/ano)
    const shareYearCard = async () => {
        try {
            const now = new Date();
            const yStart = new Date(now.getFullYear(), 0, 1).getTime();
            const list = adventures.filter((a) => { const t0 = new Date(a.start).getTime(); return t0 >= yStart && t0 <= now.getTime(); });
            const km = list.reduce((n, a) => n + a.km, 0);
            const terrC = [...new Set(list.flatMap((a) => a.countries))];
            const terrA = [...new Set(list.flatMap((a) => a.ccaa))];
            const terrP = [...new Set(list.flatMap((a) => a.prov))];
            const peakIds = [...new Set(list.flatMap((a) => a.peaks))];
            const yPeaks = peakIds.map((id) => peakById.get(id)).filter((p): p is Peak => !!p).sort((a, b) => b[3] - a[3]);
            const terrN = terrC.length + terrA.length + terrP.length;
            const up = list.reduce((n, a) => n + (a.profile?.up || 0), 0);
            let move = 0;
            for (const a of list) { const mv = movingStats(a); if (mv) move += mv.moveMs; }
            const W = 1080, H = 1350;
            const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
            const g = cv.getContext('2d'); if (!g) return;
            const FONT = '-apple-system, Segoe UI, Roboto, sans-serif';
            g.fillStyle = '#0b1017'; g.fillRect(0, 0, W, H);
            const avImg = avatar ? await new Promise<HTMLImageElement | null>((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = avatar; }) : null;
            g.save();
            g.beginPath(); g.arc(124, 112, 64, 0, Math.PI * 2); g.closePath(); g.clip();
            if (avImg) g.drawImage(avImg, 60, 48, 128, 128);
            else { g.fillStyle = '#14755f'; g.fillRect(60, 48, 128, 128); g.fillStyle = '#fff'; g.font = '700 64px ' + FONT; g.textAlign = 'center'; g.fillText((prefs.nombre.trim()[0] || '?').toUpperCase(), 124, 134); g.textAlign = 'left'; }
            g.restore();
            g.strokeStyle = 'rgba(45,200,170,0.8)'; g.lineWidth = 4;
            g.beginPath(); g.arc(124, 112, 64, 0, Math.PI * 2); g.stroke();
            g.fillStyle = '#e6edf3'; g.font = '800 62px ' + FONT;
            g.fillText('TerraUnlock', 224, 110);
            g.fillStyle = '#2dc8aa'; g.font = '700 34px ' + FONT;
            g.fillText(prefs.nombre.trim() ? t('El ano de {nombre}', { nombre: prefs.nombre.trim() }) : t('Mi ano de conquista'), 224, 170);
            g.fillStyle = '#e6edf3'; g.font = '800 58px ' + FONT;
            g.fillText(String(now.getFullYear()), 60, 268);
            const big = (val: string, lab: string, x: number, y: number, col: string) => {
                g.fillStyle = col; g.font = '800 110px ' + FONT; g.fillText(val, x, y);
                g.font = '700 38px ' + FONT; g.fillText(lab, x, y + 58);
            };
            big(dec(km, 1), t('km recorridos'), 60, 430, '#2dc8aa');
            big('+' + terrN, terrN === 1 ? t('territorio nuevo') : t('territorios nuevos'), 560, 430, '#2dc8aa');
            big(String(list.length), list.length === 1 ? t('aventura') : t('aventuras'), 60, 640, '#e6edf3');
            big('+' + yPeaks.length, yPeaks.length === 1 ? t('cima conquistada') : t('cimas conquistadas'), 560, 640, '#e8cd6e');
            big('+' + up + ' m', t('desnivel acumulado'), 60, 850, '#e8cd6e');
            big(fmtDur(move), t('en movimiento'), 560, 850, '#8fb8d8');
            let cy = 940;
            // v1.52: desglose por deporte si hay mas de uno
            const ySports = new Map<Sport, number>();
            for (const a of list) { const sp = advSport(a); if (sp) ySports.set(sp, (ySports.get(sp) || 0) + a.km); }
            if (ySports.size > 1) {
                const line = [...ySports.entries()].sort((a, b) => b[1] - a[1]).map(([sp, k2]) => sportEmoji(sp) + ' ' + dec(k2, 1) + ' km').join('   ');
                g.fillStyle = '#9fb0c0'; g.font = '600 34px ' + FONT;
                g.fillText(line, 60, cy + 8);
                cy += 60;
            }
            const newRegsCard: { rg: Region; lvl: string; stroke: string }[] = [];
            for (const n of terrC) { const rg = COUNTRIES.find((r) => r.n === n); if (rg) newRegsCard.push({ rg, lvl: t('Pais'), stroke: '#7ee0c8' }); }
            for (const n of terrA) { const rg = CCAA.find((r) => r.n === n); if (rg) newRegsCard.push({ rg, lvl: t('Comunidad'), stroke: '#e8cd6e' }); }
            for (const n of terrP) { const rg = PROV.find((r) => r.n === n); if (rg) newRegsCard.push({ rg, lvl: t('Provincia'), stroke: '#8fb8d8' }); }
            if (newRegsCard.length && cy <= 1060) {
                g.fillStyle = '#9fb0c0'; g.font = '700 28px ' + FONT;
                g.fillText(t('TERRITORIOS NUEVOS'), 60, cy + 30);
                cy += 48;
                const shown = newRegsCard.slice(0, 3);
                const tw = (W - 120 - 2 * 18) / 3, th = 200;
                shown.forEach(({ rg, lvl, stroke }, i) => {
                    const tx = 60 + i * (tw + 18), ty = cy;
                    g.fillStyle = '#0d1420'; g.beginPath(); g.roundRect(tx, ty, tw, th, 16); g.fill();
                    g.strokeStyle = '#1c2733'; g.lineWidth = 2; g.stroke();
                    drawRegionShape(g, rg, tx + 12, ty + 10, tw - 24, th - 72, 6, 'rgba(45,200,170,0.10)', stroke, 2.5);
                    let fs2 = 28;
                    g.font = '700 ' + fs2 + 'px ' + FONT;
                    while (fs2 > 16 && g.measureText(rg.n).width > tw - 36) { fs2 -= 3; g.font = '700 ' + fs2 + 'px ' + FONT; }
                    g.fillStyle = '#e6edf3'; g.textAlign = 'center';
                    g.fillText(rg.n, tx + tw / 2, ty + th - 34);
                    g.fillStyle = stroke; g.font = '600 19px ' + FONT;
                    g.fillText(lvl, tx + tw / 2, ty + th - 11);
                    g.textAlign = 'left';
                });
                cy += th + 20;
                if (newRegsCard.length > 3) { g.fillStyle = '#5c7080'; g.font = '600 26px ' + FONT; g.fillText(t('y {n} mas', { n: newRegsCard.length - 3 }), 60, cy + 20); cy += 42; }
            }
            if (yPeaks.length && cy <= 1100) {
                g.fillStyle = '#9fb0c0'; g.font = '700 28px ' + FONT;
                g.fillText(t('CIMAS'), 60, cy + 30);
                cy += 50;
                g.font = '600 31px ' + FONT;
                for (const pk of yPeaks.slice(0, 3)) {
                    g.fillStyle = '#e6edf3'; g.fillText(pk[0], 60, cy + 20);
                    g.fillStyle = '#e8cd6e'; g.textAlign = 'right'; g.fillText(pk[3] + ' m', W - 60, cy + 20); g.textAlign = 'left';
                    cy += 46;
                }
                if (yPeaks.length > 3) { g.fillStyle = '#5c7080'; g.fillText(t('y {n} mas', { n: yPeaks.length - 3 }), 60, cy + 20); }
            }
            if (!list.length) {
                g.fillStyle = '#9fb0c0'; g.font = '600 34px ' + FONT;
                g.fillText(t('Ano tranquilo... por ahora. Va a durar poco.'), 60, cy + 40);
            }
            g.fillStyle = '#5c7080'; g.font = '600 26px ' + FONT;
            g.fillText(t('Tu que has conquistado este ano? davidburgoscarpeno.github.io/TerraUnlock'), 60, H - 42);
            const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/png'));
            if (!blob) { setToast(t('No se pudo generar la tarjeta')); return; }
            await shareBlob(blob, 'terraunlock-ano.png', t('TerraUnlock: mi ano'));
        } catch (e) {
            if (e instanceof Error && e.name === 'AbortError') return;
            setToast(t('No se pudo compartir la tarjeta'));
        }
    };

    // v1.12: tarjeta PNG de una aventura (perfil + cifras + desbloqueos)
    // v1.14: importar un GPX suelto como aventura completa (revela niebla + entra en la lista)
    const importGpxAdventure = async (file: File) => {
        try {
            const text = await file.text();
            const g = parseGpx(text);
            const doc = new DOMParser().parseFromString(text, 'application/xml');
            const times: string[] = [];
            doc.querySelectorAll('trkpt time').forEach((el) => { if (el.textContent) times.push(el.textContent); });
            const t0 = times.length ? new Date(times[0]) : new Date();
            const t1 = times.length ? new Date(times[times.length - 1]) : t0;
            const start = isFinite(t0.getTime()) ? t0.toISOString() : new Date().toISOString();
            const end = isFinite(t1.getTime()) && t1.getTime() >= new Date(start).getTime() ? t1.toISOString() : start;
            const p0 = progressRef.current;
            const sc = scanTrack(g.name, g.pts, p0, peakGrid, g.times);
            // v1.29: no duplicar si esa actividad ya esta en el historial
            const gGeom = trackGeom(sc.pts, sc.km);
            const t0s = (sc.times || []).find((x) => x);
            const ds2 = dupSets(adventuresRef.current);
            if (gGeom && (t0s ? ds2.sig.has(new Date(t0s).toISOString().slice(0, 16) + '|' + gGeom) : ds2.geom.has(gGeom))) { setToast(t('Esa actividad ya la tenias importada')); return; }
            const next: Progress = {
                countries: [...p0.countries, ...sc.countries],
                ccaa: [...p0.ccaa, ...sc.ccaa],
                prov: [...p0.prov, ...sc.prov],
                peaks: [...p0.peaks, ...sc.peaks],
                cells: sc.cells,
                points: [...p0.points, ...sc.pts].slice(-50000),
            };
            setProgress(next); saveProgress(next);
            const stride = Math.max(1, Math.ceil(sc.pts.length / 300));
            const tr = sc.pts.filter((_, i) => i % stride === 0);
            const lastPt = sc.pts[sc.pts.length - 1];
            const lastTr = tr[tr.length - 1];
            if (lastTr && (lastTr[0] !== lastPt[0] || lastTr[1] !== lastPt[1])) tr.push(lastPt);
            let ttg: number[] | undefined;
            if (sc.times && sc.times.length === sc.pts.length) {
                const rawMs = sc.times.map((x) => (x ? new Date(x).getTime() : NaN));
                if (rawMs.every((n) => isFinite(n))) {
                    const dm = rawMs.filter((_, i) => i % stride === 0);
                    if (dm.length < tr.length) dm.push(rawMs[rawMs.length - 1]);
                    ttg = dm;
                }
            }
            const durG = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
            const done: Adventure = {
                start, end, km: Math.round(sc.km * 10) / 10, points: sc.pts.length,
                countries: sc.countries, ccaa: sc.ccaa, prov: sc.prov, peaks: sc.peaks,
                track: tr.length >= 2 ? tr : undefined, times: ttg,
                sport: durG > 0 && sc.km > 0.05 ? inferSportSecPerKm(durG / sc.km) : undefined,
            };
            const list = [done, ...adventures].slice(0, 50);
            setAdventures(list); saveJson(ADVS_KEY, list);
            setAdvSummary(done);
            const parts: string[] = [];
            if (sc.prov.length) parts.push(t(sc.prov.length > 1 ? '{n} provincias' : '{n} provincia', { n: sc.prov.length }));
            if (sc.ccaa.length) parts.push(t(sc.ccaa.length > 1 ? '{n} comunidades' : '{n} comunidad', { n: sc.ccaa.length }));
            if (sc.countries.length) parts.push(t(sc.countries.length > 1 ? '{n} paises' : '{n} pais', { n: sc.countries.length }));
            if (sc.peaks.length) parts.push(t(sc.peaks.length > 1 ? '{n} cimas' : '{n} cima', { n: sc.peaks.length }));
            if (parts.length) { setBanners((bb) => [...bb, { title: t('Aventura importada'), sub: '+' + parts.join(', +') }]); try { navigator.vibrate?.(80); } catch { /* sin vibracion */ } }
        } catch { setToast(t('No se pudo leer ese GPX')); }
    };

    // v1.13: exportar la aventura a GPX (descarga directa; el share sheet de movil no acepta bien .gpx)
    const exportGpx = async (adv: Adventure) => {
        try {
            if (!adv.track || adv.track.length < 2) { setToast(t('Esta aventura no tiene track GPS para exportar')); return; }
            let prof = adv.profile || null;
            if (!prof && !adv.noProfile) {
                try { prof = await computeProfile(adv.track); saveProfile(adv.start, prof); } catch { prof = null; }
            }
            const gpx = adventureToGpx(adv, prof, adv.name || prefs.nombre);
            const blob = new Blob([gpx], { type: 'application/gpx+xml' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = gpxFilename(adv);
            a.click();
            setToast(t('GPX descargado: listo para Strava, Garmin o Wikiloc'));
        } catch { setToast(t('No se pudo exportar el GPX')); }
    };

    const shareAdventureCard = async (adv: Adventure) => {
        try {
            let prof = adv.profile || null;
            if (!prof && adv.track && adv.track.length >= 2 && !adv.noProfile) {
                try { prof = await computeProfile(adv.track); saveProfile(adv.start, prof); } catch { prof = null; }
            }
            // v1.22: mini-mapa de la ruta; si ademas hay perfil de elevacion la tarjeta crece
            const hasRoute = !!(adv.track && adv.track.length >= 2);
            const W = 1080, H = 1350 + (hasRoute && prof ? 420 : 0);
            const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
            const g = cv.getContext('2d'); if (!g) return;
            g.fillStyle = '#0b1017'; g.fillRect(0, 0, W, H);
            const avImg = avatar ? await new Promise<HTMLImageElement | null>((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = avatar; }) : null;
            g.save();
            g.beginPath(); g.arc(124, 112, 64, 0, Math.PI * 2); g.closePath(); g.clip();
            if (avImg) g.drawImage(avImg, 60, 48, 128, 128);
            else { g.fillStyle = '#14755f'; g.fillRect(60, 48, 128, 128); g.fillStyle = '#fff'; g.font = '700 64px -apple-system, Segoe UI, Roboto, sans-serif'; g.textAlign = 'center'; g.fillText((prefs.nombre.trim()[0] || '?').toUpperCase(), 124, 134); g.textAlign = 'left'; }
            g.restore();
            g.strokeStyle = 'rgba(45,200,170,0.8)'; g.lineWidth = 4;
            g.beginPath(); g.arc(124, 112, 64, 0, Math.PI * 2); g.stroke();
            g.fillStyle = '#e6edf3'; g.font = '800 62px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText('TerraUnlock', 224, 110);
            g.fillStyle = '#2dc8aa'; g.font = '700 34px -apple-system, Segoe UI, Roboto, sans-serif';
            const fecha = new Date(adv.start);
            g.fillText((sportEmoji(advSport(adv)) ? sportEmoji(advSport(adv)) + ' ' : '') + (adv.name ? adv.name + ' - ' : (prefs.nombre.trim() ? t('Aventura de {nombre}', { nombre: prefs.nombre.trim() }) : t('Mi aventura')) + ' - ') + fecha.toLocaleDateString(dateLocale()), 224, 170);
            // cifras grandes
            g.fillStyle = '#2dc8aa'; g.font = '800 120px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(fmtDist(adv.km), 60, 330);
            const horas = Math.max(0, (new Date(adv.end).getTime() - fecha.getTime()) / 3600000);
            const dur = horas >= 1 ? Math.floor(horas) + ' h ' + Math.round((horas % 1) * 60) + ' min' : Math.round(horas * 60) + ' min';
            // fila de cajas de stats
            const boxes: [string, string][] = [[t('PUNTOS GPS'), String(adv.points)], [t('DURACION'), dur]];
            if (prof) { boxes.push([t('SUBIDA'), '+' + prof.up + ' m']); boxes.push([t('BAJADA'), '-' + prof.down + ' m']); }
            const bw = (W - 120 - (boxes.length - 1) * 18) / boxes.length;
            boxes.forEach(([lab, val], i) => {
                const bx = 60 + i * (bw + 18);
                g.fillStyle = '#111927'; g.beginPath(); g.roundRect(bx, 400, bw, 122, 16); g.fill();
                g.strokeStyle = '#1c2733'; g.lineWidth = 2; g.stroke();
                g.fillStyle = '#5c7080'; g.font = '700 24px -apple-system, Segoe UI, Roboto, sans-serif';
                g.fillText(lab, bx + 24, 444);
                g.fillStyle = '#e6edf3'; g.font = '800 44px -apple-system, Segoe UI, Roboto, sans-serif';
                g.fillText(val, bx + 24, 500);
            });
            // v1.21: ritmo medio y mejor km/milla (si la aventura tiene timestamps)
            const ps = paceStats(adv, imp);
            if (ps) {
                g.fillStyle = '#2dc8aa'; g.font = '700 34px -apple-system, Segoe UI, Roboto, sans-serif';
                g.fillText(t('Ritmo medio {pace}', { pace: fmtPace(ps.avg, imp) }) + (ps.best ? t(imp ? ' - Mejor milla {pace}' : ' - Mejor km {pace}', { pace: fmtPace(ps.best, imp) }) : ''), 60, 575);
            }
            // v1.45: tiempo en movimiento y pausas en la tarjeta (si hay timestamps)
            const mvCard = movingStats(adv);
            if (mvCard) {
                g.fillStyle = '#8fb8d8'; g.font = '700 34px -apple-system, Segoe UI, Roboto, sans-serif';
                g.fillText(t('En movimiento {dur}', { dur: fmtDur(mvCard.moveMs) }) + (mvCard.pauseMs >= 60000 ? t(' - Pausas {dur}', { dur: fmtDur(mvCard.pauseMs) }) : ''), 60, ps ? 615 : 575);
            }
            // v1.22: mini-mapa de la ruta (polyline teal con inicio y fin)
            let cy = ps && mvCard ? 655 : ps || mvCard ? 615 : 560;
            if (hasRoute && adv.track) {
                const tr = adv.track;
                let minLa = 90, maxLa = -90, minLo = 180, maxLo = -180;
                for (const p of tr) {
                    if (p[0] < minLa) minLa = p[0];
                    if (p[0] > maxLa) maxLa = p[0];
                    if (p[1] < minLo) minLo = p[1];
                    if (p[1] > maxLo) maxLo = p[1];
                }
                const px = 60, py = cy, pw = W - 120, ph = 380, pad = 28;
                g.fillStyle = '#111927'; g.beginPath(); g.roundRect(px, py, pw, ph, 16); g.fill();
                g.strokeStyle = '#1c2733'; g.lineWidth = 2; g.stroke();
                const spanLo = Math.max(1e-9, maxLo - minLo), spanLa = Math.max(1e-9, maxLa - minLa);
                const sc = Math.min((pw - pad * 2) / spanLo, (ph - pad * 2) / spanLa);
                const offX = px + pad + ((pw - pad * 2) - spanLo * sc) / 2;
                const offY = py + pad + ((ph - pad * 2) - spanLa * sc) / 2;
                const X = (lo: number) => offX + (lo - minLo) * sc;
                const Y = (la: number) => offY + (maxLa - la) * sc;
                g.save();
                g.beginPath(); g.roundRect(px, py, pw, ph, 16); g.clip();
                g.beginPath();
                for (let i = 0; i < tr.length; i++) { const x = X(tr[i][1]), y = Y(tr[i][0]); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); }
                g.strokeStyle = '#2dc8aa'; g.lineWidth = 5; g.lineJoin = 'round'; g.lineCap = 'round'; g.stroke();
                const dot = (x: number, y: number, r: number, fill: string) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = fill; g.fill(); g.strokeStyle = '#0b1017'; g.lineWidth = 3; g.stroke(); };
                dot(X(tr[0][1]), Y(tr[0][0]), 11, '#2dc8aa');
                const lp = tr[tr.length - 1];
                dot(X(lp[1]), Y(lp[0]), 11, '#e8cd6e');
                g.restore();
                cy += 420;
            }
            // perfil
            if (prof) {
                g.save();
                g.beginPath(); g.rect(60, cy, W - 120, 480); g.clip();
                drawProfile(g, 60, cy, W - 120, 480, prof, 26);
                g.restore();
                g.strokeStyle = '#1c2733'; g.lineWidth = 2; g.strokeRect(60, cy, W - 120, 480);
                cy += 520;
            }
            // desbloqueos
            const terrC = adv.countries, terrA = adv.ccaa, terrP = adv.prov;
            const chip2 = (t: string, x: number, y: number, fg: string, bg: string) => {
                g.font = '600 30px -apple-system, Segoe UI, Roboto, sans-serif';
                const w = g.measureText(t).width + 44;
                g.beginPath();
                g.moveTo(x + 14, y); g.lineTo(x + w - 14, y); g.arcTo(x + w, y, x + w, y + 14, 14); g.lineTo(x + w, y + 34); g.arcTo(x + w, y + 48, x + w - 14, y + 48, 14); g.lineTo(x + 14, y + 48); g.arcTo(x, y + 48, x, y + 34, 14); g.lineTo(x, y + 14); g.arcTo(x, y, x + 14, y, 14); g.closePath();
                g.fillStyle = bg; g.fill();
                g.fillStyle = fg; g.fillText(t, x + 22, y + 35);
                return w;
            };
            const chipRow2 = (title: string, names: string[], fg: string, bg: string) => {
                if (!names.length || cy > H - 250) return;
                g.fillStyle = '#9fb0c0'; g.font = '700 28px -apple-system, Segoe UI, Roboto, sans-serif';
                g.fillText(title, 60, cy + 34);
                cy += 52;
                let cx = 60;
                for (const n of names) {
                    const w = chip2(n, cx, cy, fg, bg);
                    cx += w + 14;
                    if (cx > W - 120) { cx = 60; cy += 62; }
                }
                cy += 78;
            };
            chipRow2(t('PAISES'), terrC, '#7ee0c8', '#123a31');
            chipRow2(t('COMUNIDADES'), terrA, '#e8cd6e', '#2f2a12');
            chipRow2(t('PROVINCIAS'), terrP, '#8fb8d8', '#1a2634');
            if (adv.peaks.length && cy <= H - 250) {
                const pks = adv.peaks.map((id) => peakById.get(id)).filter((p): p is Peak => !!p).sort((a, b) => b[3] - a[3]);
                g.fillStyle = '#9fb0c0'; g.font = '700 28px -apple-system, Segoe UI, Roboto, sans-serif';
                g.fillText(t('CIMAS'), 60, cy + 34);
                cy += 56;
                g.font = '600 31px -apple-system, Segoe UI, Roboto, sans-serif';
                for (const p of pks.slice(0, 4)) {
                    g.fillStyle = '#e6edf3'; g.fillText(p[0], 60, cy + 20);
                    g.fillStyle = '#e8cd6e'; g.textAlign = 'right'; g.fillText(p[3] + ' m', W - 60, cy + 20); g.textAlign = 'left';
                    cy += 48;
                }
            }
            if (!terrC.length && !terrA.length && !terrP.length && !adv.peaks.length) {
                g.fillStyle = '#9fb0c0'; g.font = '600 32px -apple-system, Segoe UI, Roboto, sans-serif';
                g.fillText(t('Ruta sin desbloqueos nuevos: terreno ya conquistado.'), 60, cy + 30);
            }
            g.fillStyle = '#5c7080'; g.font = '600 26px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText(t('A que no tienes una aventura mejor? davidburgoscarpeno.github.io/TerraUnlock'), 60, H - 42);
            const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/png'));
            if (!blob) { setToast(t('No se pudo generar la tarjeta')); return; }
            await shareBlob(blob, 'terraunlock-aventura.png', t('TerraUnlock: mi aventura'));
        } catch (e) {
            if (e instanceof Error && e.name === 'AbortError') return;
            setToast(t('No se pudo compartir la tarjeta'));
        }
    };

    // v1.3: racha (dias seguidos revelando)
    const [streak, setStreak] = useState<Streak>(() => loadJson<Streak>(STREAK_KEY) || { last: '', count: 0 });
    // v1.2: logros (desbloqueo + celebracion) y HUD (escala + cima cercana)
    const [achUnlocked, setAchUnlocked] = useState<Record<string, string>>(() => loadAch() || {});
    const achSeed = useRef(loadAch() == null); // primera vez con la funcion: siembra silenciosa
    const [celebration, setCelebration] = useState<Achievement[]>([]);
    // v1.5: foto de perfil (dataURL 256px en localStorage; sin cuentas)
    const [avatar, setAvatarState] = useState<string>(() => { try { return localStorage.getItem(AVATAR_KEY) || ''; } catch { return ''; } });
    const setAvatar = (url: string) => {
        setAvatarState(url);
        try { if (url) localStorage.setItem(AVATAR_KEY, url); else localStorage.removeItem(AVATAR_KEY); }
        catch { setToast(t('Foto demasiado grande para guardar en este dispositivo')); }
    };
    const processAvatar = (file: File) => {
        const rd = new FileReader();
        rd.onload = () => {
            const img = new Image();
            img.onload = () => {
                const side = Math.min(img.width, img.height);
                const cv = document.createElement('canvas'); cv.width = cv.height = 256;
                const g = cv.getContext('2d'); if (!g) return;
                g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 256, 256);
                setAvatar(cv.toDataURL('image/jpeg', 0.85));
            };
            img.onerror = () => setToast(t('No se pudo leer esa imagen'));
            img.src = String(rd.result);
        };
        rd.readAsDataURL(file);
    };
    // v1.4: aviso celebratorio al entrar en territorio nuevo (banner, no pantalla completa)
    const [banners, setBanners] = useState<TerrBanner[]>([]);
    useEffect(() => {
        if (!banners.length) return;
        const t = setTimeout(() => setBanners((b) => b.slice(1)), 8000);
        return () => clearTimeout(t);
    }, [banners]);
    useEffect(() => {
        const seed = achSeed.current;
        achSeed.current = false;
        const newly = ACHIEVEMENTS.filter((a) => !achUnlocked[a.id] && a.test(progress, streak));
        if (!newly.length) return;
        const now = new Date().toISOString();
        const next = { ...achUnlocked };
        for (const a of newly) next[a.id] = now;
        saveAch(next);
        setAchUnlocked(next);
        if (!seed) setCelebration((c) => [...c, ...newly]);
    }, [progress, achUnlocked, streak]);
    const scaleBar = useMemo(() => {
        const mpp = 40075016 * Math.cos(view.lat * Math.PI / 180) / (256 * Math.pow(2, view.z));
        if (!isFinite(mpp) || mpp <= 0) return null;
        const target = 90 * mpp;
        const pow = Math.pow(10, Math.floor(Math.log10(target)));
        let best = pow;
        for (const m of [1, 2, 5]) if (m * pow <= target) best = m * pow;
        return { w: best / mpp, label: best >= 1000 ? fmtDist(best / 1000) : Math.round(best) + ' m' };
    }, [view.lat, view.z]);
    const rlat = Math.round(view.lat * 10) / 10, rlon = Math.round(view.lon * 10) / 10;
    const nearestPeak = useMemo(() => {
        let best: { p: Peak; d: number } | null = null;
        for (const p of allPeaks) {
            if (Math.abs(p[1] - rlat) > 0.25 || Math.abs(p[2] - rlon) > 0.4) continue;
            if (progress.peaks.includes(peakId(p))) continue;
            const d = distM([rlat, rlon], [p[1], p[2]]);
            if (d < 25000 && (!best || d < best.d)) best = { p, d };
        }
        return best;
    }, [rlat, rlon, allPeaks, progress.peaks]);

    // v1.6: que me falta cerca (territorios sin conquistar alrededor)
    const nearMissing = useMemo(() => {
        const ref: [number, number] = lastPos ? lastPos : [view.lat, view.lon];
        const bearing8 = (to: [number, number]) => {
            const lat1 = ref[0] * Math.PI / 180, lat2 = to[0] * Math.PI / 180, dLon = (to[1] - ref[1]) * Math.PI / 180;
            const y = Math.sin(dLon) * Math.cos(lat2);
            const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
            return compass8(x, y);
        };
        const distToRegion = (rg: Region) => {
            let best = Infinity;
            for (const ring of rg.r) for (let i = 0; i < ring.length; i += 2) {
                const d = distM(ref, [ring[i + 1], ring[i]]);
                if (d < best) best = d;
            }
            return best;
        };
        const items: { name: string; level: string; d: number; dir: string; lon: number; lat: number }[] = [];
        const push = (regs: Region[], have: string[], level: string) => {
            for (const rg of regs) {
                if (have.includes(rg.n)) continue;
                if (ref[0] < rg.b[1] - 1.5 || ref[0] > rg.b[3] + 1.5 || ref[1] < rg.b[0] - 1.5 || ref[1] > rg.b[2] + 1.5) continue;
                const d = distToRegion(rg);
                if (d <= 150000) items.push({ name: rg.n, level, d, dir: bearing8([rg.c[1], rg.c[0]]), lon: rg.c[0], lat: rg.c[1] });
            }
        };
        const inSpain = ref[1] >= SPAIN_BBOX[0] && ref[1] <= SPAIN_BBOX[2] && ref[0] >= SPAIN_BBOX[1] && ref[0] <= SPAIN_BBOX[3];
        if (inSpain) { push(PROV, progress.prov, 'Provincia'); push(CCAA, progress.ccaa, 'Comunidad'); }
        else push(COUNTRIES, progress.countries, 'Pais');
        return items.sort((a, b) => a.d - b.d).slice(0, 5);
    }, [lastPos, view.lat, view.lon, progress.prov, progress.ccaa, progress.countries]);

    // v1.3: modo aventura y racha
    const [adv, setAdv] = useState<ActiveAdventure | null>(() => loadJson<ActiveAdventure>(ADV_ACTIVE_KEY));
    const advRef = useRef(adv);
    useEffect(() => { advRef.current = adv; }, [adv]);
    const [adventures, setAdventures] = useState<Adventure[]>(() => loadJson<Adventure[]>(ADVS_KEY) || []);
    const multiSeed = useRef(true);
    useEffect(() => {
        const seed2 = multiSeed.current;
        multiSeed.current = false;
        // v1.54: logros basados en aventuras (multideporte + totales de distancia y desnivel)
        const sports = new Set<Sport>();
        let kmTot = 0, upTot = 0;
        for (const a of adventures) { const sp = advSport(a); if (sp) sports.add(sp); kmTot += a.km; upTot += a.profile?.up || 0; }
        const earned: string[] = [];
        if (sports.size >= 3) earned.push('multi-3');
        for (const [id, th] of [['dist-50', 50], ['dist-250', 250], ['dist-1000', 1000]] as [string, number][]) if (kmTot >= th) earned.push(id);
        for (const [id, th] of [['up-1000', 1000], ['up-5000', 5000], ['up-8848', 8848]] as [string, number][]) if (upTot >= th) earned.push(id);
        const fresh = earned.filter((id) => !achUnlocked[id]);
        if (!fresh.length) return;
        const now = new Date().toISOString();
        const next = { ...achUnlocked };
        for (const id of fresh) next[id] = now;
        setAchUnlocked(next); saveAch(next);
        if (!seed2) {
            const news = ACHIEVEMENTS.filter((x) => fresh.includes(x.id));
            if (news.length) setCelebration((c) => [...c, ...news]);
        }
    }, [adventures, achUnlocked]);
    const adventuresRef = useRef(adventures); adventuresRef.current = adventures;
    // v1.15: racha de objetivos semanales cumplidos seguidos
    const [weekStreak, setWeekStreak] = useState<WeekStreak>(() => loadJson<WeekStreak>(WSTREAK_KEY) || { last: '', count: 0 });
    // v1.77: instalacion PWA (beforeinstallprompt en Android/desktop, instrucciones manuales en iOS)
    const deferredInstall = useRef<{ prompt: () => void; userChoice: Promise<{ outcome: string }> } | null>(null);
    const [canInstall, setCanInstall] = useState(false);
    const isIOS = useMemo(() => /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as unknown as { MSStream?: unknown }).MSStream, []);
    const isStandalone = useMemo(() => window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true, []);
    useEffect(() => {
        const onBIP = (e: Event) => { e.preventDefault(); deferredInstall.current = e as unknown as { prompt: () => void; userChoice: Promise<{ outcome: string }> }; setCanInstall(true); };
        const onInstalled = () => { deferredInstall.current = null; setCanInstall(false); };
        window.addEventListener('beforeinstallprompt', onBIP);
        window.addEventListener('appinstalled', onInstalled);
        return () => { window.removeEventListener('beforeinstallprompt', onBIP); window.removeEventListener('appinstalled', onInstalled); };
    }, []);
    const installApp = async () => {
        const e = deferredInstall.current; if (!e) return;
        e.prompt();
        try { await e.userChoice; } catch { /* ignorado */ }
        deferredInstall.current = null; setCanInstall(false);
    };
    // v1.9: objetivo semanal automatico (3 territorios nuevos o 1 cima; se reinicia cada lunes)
    const [weekly, setWeekly] = useState<WeeklyGoal>(() => {
        const saved = loadJson<WeeklyGoal>(WEEK_KEY);
        if (saved && saved.week === weekKey(new Date())) return saved;
        const w = newWeeklyGoal(loadProgress());
        saveJson(WEEK_KEY, w);
        return w;
    });
    useEffect(() => {
        if (weekly.week !== weekKey(new Date())) {
            const w = newWeeklyGoal(progress);
            setWeekly(w); saveJson(WEEK_KEY, w);
            return;
        }
        const newTerr = progress.countries.length + progress.ccaa.length + progress.prov.length - weekly.countries0.length - weekly.ccaa0.length - weekly.prov0.length;
        const newPeaks = progress.peaks.length - weekly.peaks0.length;
        if (!weekly.celebrated && (newTerr >= WEEK_TERR || newPeaks >= WEEK_PEAK)) {
            const w = { ...weekly, celebrated: true };
            setWeekly(w); saveJson(WEEK_KEY, w);
            setCelebration((c) => [...c, {
                id: 'weekly-' + weekly.week,
                ico: '🎯',
                title: 'Objetivo semanal cumplido',
                hint: newPeaks >= WEEK_PEAK
                    ? t(newPeaks === 1 ? 'Has conquistado {n} cima esta semana' : 'Has conquistado {n} cimas esta semana', { n: newPeaks })
                    : t('Has desbloqueado {n} territorios nuevos esta semana', { n: newTerr }),
                test: () => true,
            }]);
            // v1.15: racha de semanas cumpliendo el objetivo
            if (weekStreak.last !== weekly.week) {
                const prevWeek = weekKey(new Date(Date.now() - 7 * 86400000));
                const count = weekStreak.last === prevWeek ? weekStreak.count + 1 : 1;
                const ws = { last: weekly.week, count };
                setWeekStreak(ws); saveJson(WSTREAK_KEY, ws);
                const hit = [2, 4, 8, 12].filter((n) => count >= n && !achUnlocked['wstreak-' + n]);
                if (hit.length) {
                    const next = { ...achUnlocked };
                    const at = new Date().toISOString();
                    const newAch: Achievement[] = [];
                    for (const n of hit) {
                        const a = ACHIEVEMENTS.find((x) => x.id === 'wstreak-' + n);
                        if (a) { next[a.id] = at; newAch.push(a); }
                    }
                    setAchUnlocked(next); saveAch(next);
                    setCelebration((c) => [...c, ...newAch]);
                }
            }
        }
    }, [progress, weekly]);
    const [advSummary, setAdvSummary] = useState<Adventure | null>(null);
    const [advTick, setAdvTick] = useState(0);
    useEffect(() => { if (!adv) return; const t = setInterval(() => setAdvTick((x) => x + 1), 15000); return () => clearInterval(t); }, [adv]);
    const startAdventure = () => {
        const p = progressRef.current;
        const a: ActiveAdventure = { start: new Date().toISOString(), km: 0, points: 0, countries0: p.countries, ccaa0: p.ccaa, prov0: p.prov, peaks0: p.peaks, points0: p.points.length, times: [] };
        advRef.current = a; setAdv(a); saveJson(ADV_ACTIVE_KEY, a);
        setToast(t('Aventura empezada: sal a conquistar'));
    };
    // v1.82: atajos de la app instalada (manifest shortcuts): ?accion=empezar|progreso
    useEffect(() => {
        try {
            const q = new URLSearchParams(window.location.search);
            const acc = q.get('accion');
            if (!acc) return;
            window.history.replaceState(null, '', window.location.pathname);
            if (acc === 'empezar') { setTab('mapa'); if (!advRef.current) startAdventure(); }
            else if (acc === 'progreso') setTab('progreso');
        } catch { /* parametro ignorado */ }
        // solo al montar
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const endAdventure = () => {
        const a = advRef.current;
        if (!a) return;
        const p = progressRef.current;
        const durSec = (Date.now() - new Date(a.start).getTime()) / 1000;
        const done: Adventure = {
            start: a.start, end: new Date().toISOString(), km: a.km, points: a.points,
            sport: durSec > 0 && a.km > 0.05 ? inferSportSecPerKm(durSec / a.km) : undefined,
            countries: p.countries.filter((n) => !a.countries0.includes(n)),
            ccaa: p.ccaa.filter((n) => !a.ccaa0.includes(n)),
            prov: p.prov.filter((n) => !a.prov0.includes(n)),
            peaks: p.peaks.filter((n) => !a.peaks0.includes(n)),
        };
        // v1.11: traza de la aventura (diezmada a ~300 puntos) para el perfil de elevacion
        if (a.points0 != null) {
            const pts = p.points.slice(a.points0);
            if (pts.length >= 2) {
                const stride = Math.max(1, Math.ceil(pts.length / 300));
                const tr = pts.filter((_, i) => i % stride === 0);
                const lastPt = pts[pts.length - 1];
                const lastTr = tr[tr.length - 1];
                if (lastTr[0] !== lastPt[0] || lastTr[1] !== lastPt[1]) tr.push(lastPt);
                done.track = tr;
                // v1.16: timestamps reales por punto (mismo diezmado que la traza)
                if (a.times && a.times.length === pts.length) {
                    const tt = a.times.filter((_, i) => i % stride === 0);
                    if (tt.length < tr.length) tt.push(a.times[a.times.length - 1]);
                    done.times = tt;
                }
            }
        }
        const list = [done, ...adventures].slice(0, 50);
        setAdventures(list); saveJson(ADVS_KEY, list);
        advRef.current = null; setAdv(null);
        try { localStorage.removeItem(ADV_ACTIVE_KEY); } catch { /* sin espacio */ }
        setAdvSummary(done);
    };
    // v1.11: guardar el perfil calculado dentro de la aventura
    const saveProfile = (start: string, prof: AdventureProfile | null) => {
        setAdventures((list) => {
            const next = list.map((x) => x.start === start ? { ...x, ...(prof ? { profile: prof } : { noProfile: true }) } : x);
            saveJson(ADVS_KEY, next);
            return next;
        });
        setAdvSummary((cur) => (cur && cur.start === start ? { ...cur, ...(prof ? { profile: prof } : { noProfile: true }) } : cur));
    };
    const [advOpen, setAdvOpen] = useState<string | null>(null);
    // v1.79: deshacer borrado de aventura (ventana de 8 s)
    const [undoAdv, setUndoAdv] = useState<Adventure | null>(null);
    const undoAdvTimer = useRef<number | null>(null);
    const offerUndoAdv = (a: Adventure) => {
        setUndoAdv(a); setToast(t('Aventura borrada'));
        if (undoAdvTimer.current) window.clearTimeout(undoAdvTimer.current);
        undoAdvTimer.current = window.setTimeout(() => setUndoAdv(null), 8000);
    };
    const undoDeleteAdv = () => {
        if (!undoAdv) return;
        const back = undoAdv;
        setAdventures((cur) => { const list = [back, ...cur]; saveJson(ADVS_KEY, list); return list; });
        if (undoAdvTimer.current) { window.clearTimeout(undoAdvTimer.current); undoAdvTimer.current = null; }
        setUndoAdv(null); setToast(t('Aventura restaurada'));
    };

    const advElapsed = adv ? (() => { const m = Math.max(0, Math.floor((Date.now() + advTick * 0 - new Date(adv.start).getTime()) / 60000)); return m >= 60 ? Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min' : m + ' min'; })() : '';

    const km2 = (progress.cells.length * 1.1).toFixed(0);
    const conqueredPeaks = progress.peaks.map((id) => peakById.get(id)).filter((p): p is Peak => !!p).sort((a, b) => b[3] - a[3]);
    // v1.91: resumen visual de la pestana Cimas
    const peakSumEle = conqueredPeaks.reduce((sum, p) => sum + p[3], 0);
    const peakTop = conqueredPeaks.length ? conqueredPeaks[0] : null;
    // v1.59: las 20 cimas mas altas aun sin conquistar
    const pendingTopPeaks = useMemo(() => {
        const won = new Set(progress.peaks);
        return allPeaks.filter((pk) => !won.has(peakId(pk))).sort((a, b) => b[3] - a[3]).slice(0, 20);
    }, [allPeaks, progress.peaks]);

    // v1.23: estadisticas del mes actual vs el anterior (a partir de las aventuras)
    // v1.37: totales historicos de aventuras (tiempo en movimiento y desnivel)
    const totalStats = useMemo(() => {
        let ms = 0, up = 0, profN = 0;
        for (const a of adventures) {
            // v1.40: con timestamps por punto se suma el tiempo en movimiento (sin pausas)
            const mv = movingStats(a);
            if (mv) ms += mv.moveMs;
            else {
                const t0 = new Date(a.start).getTime(), t1 = new Date(a.end).getTime();
                if (isFinite(t0) && isFinite(t1) && t1 >= t0) ms += t1 - t0;
            }
            if (a.profile) { up += a.profile.up; profN++; }
        }
        return { ms, up, profN, n: adventures.length };
    }, [adventures]);
    // v1.46: filtro del historial por deporte
    const [sportFilter, setSportFilter] = useState<Sport | null>(null);
    // v1.48: buscador de texto en el historial (nombre, fecha o territorio desbloqueado)
    const [advQuery, setAdvQuery] = useState('');
    const advFiltered = useMemo(() => {
        let list = sportFilter ? adventures.filter((a) => advSport(a) === sportFilter) : adventures;
        const q = advQuery.trim().toLowerCase();
        if (q) list = list.filter((a) => (a.name || '').toLowerCase().includes(q)
            || new Date(a.start).toLocaleDateString(dateLocale()).includes(q)
            || [...a.countries, ...a.ccaa, ...a.prov].some((n) => n.toLowerCase().includes(q)));
        return list;
    }, [adventures, sportFilter, advQuery]);
    // v1.47: orden del historial (reciente por defecto)
    const [advSort, setAdvSort] = useState<'rec' | 'km' | 'up'>('rec');
    // v1.49: paginacion del historial (tandas de 20)
    const [advLimit, setAdvLimit] = useState(20);
    useEffect(() => { setAdvLimit(20); }, [sportFilter, advQuery, advSort, adventures.length]);
    const advShown = useMemo(() => {
        const list = [...advFiltered];
        if (advSort === 'rec') list.sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime());
        else if (advSort === 'km') list.sort((a, b) => b.km - a.km);
        else list.sort((a, b) => (b.profile?.up || 0) - (a.profile?.up || 0));
        return list;
    }, [advFiltered, advSort]);
    const sportsPresent = useMemo(() => {
        const set = new Set<Sport>();
        for (const a of adventures) { const sp = advSport(a); if (sp) set.add(sp); }
        return [...set];
    }, [adventures]);
    // v1.42: distancia y aventuras por deporte (Strava lo indica; el resto inferido del ritmo)
    const sportChips = useMemo(() => {
        const m = new Map<Sport, { km: number; n: number }>();
        for (const a of adventures) {
            const s = advSport(a); if (!s) continue;
            const cur = m.get(s) || { km: 0, n: 0 };
            cur.km += a.km; cur.n++;
            m.set(s, cur);
        }
        return [...m.entries()].map(([s, v]) => ({ s, ...v })).sort((x, y) => y.km - x.km);
    }, [adventures]);
    // v1.38: calendario de actividad (km por dia, ultimas 20 semanas)
    // v1.69: filtro por deporte del calendario
    const [heatSport, setHeatSport] = useState<Sport | null>(null);
    const heatWeeks = useMemo(() => {
        const days = new Map<string, number>();
        for (const a of adventures) {
            if (heatSport && advSport(a) !== heatSport) continue;
            const d = new Date(a.start);
            if (!isFinite(d.getTime())) continue;
            const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
            days.set(k, (days.get(k) || 0) + a.km);
        }
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const dow = (today.getDay() + 6) % 7; // lunes = 0
        const end = new Date(today); end.setDate(end.getDate() + (6 - dow));
        const start = new Date(end); start.setDate(start.getDate() - 20 * 7 + 1);
        const weeks: ({ k: string; lv: number; km: number; label: string } | null)[][] = [];
        const cur = new Date(start);
        while (cur <= end) {
            const col: ({ k: string; lv: number; km: number; label: string } | null)[] = [];
            for (let i = 0; i < 7; i++) {
                if (cur > today) { col.push(null); cur.setDate(cur.getDate() + 1); continue; }
                const k = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0');
                const km = days.get(k) || 0;
                const lv = km <= 0 ? 0 : km < 5 ? 1 : km < 15 ? 2 : 3;
                col.push({ k, lv, km, label: cur.getDate() + ' ' + monthName(cur.getMonth()) });
                cur.setDate(cur.getDate() + 1);
            }
            weeks.push(col);
        }
        return weeks;
    }, [adventures, heatSport]);
    // v1.71: etiquetas de mes bajo el calendario (cambia cuando el lunes de la columna entra en un mes nuevo)
    const heatMonths = useMemo(() => {
        let prev = -1;
        return heatWeeks.map((col) => {
            const first = col.find((d) => d !== null);
            if (!first) return '';
            const m = parseInt(first.k.slice(5, 7), 10) - 1;
            if (m === prev) return '';
            prev = m;
            return monthName(m).slice(0, 3);
        });
    }, [heatWeeks]);

    const fmtDurTotal = (ms: number) => {
        const m = Math.round(ms / 60000);
        if (m < 60) return m + ' min';
        const h = Math.floor(m / 60);
        if (h < 24) return h + ' h ' + String(m % 60).padStart(2, '0') + ' min';
        const d = Math.floor(h / 24);
        return t('{d} d {h} h', { d, h: h % 24 });
    };

    const monthStats = (() => {
        const now = new Date();
        const mStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        const pStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
        const agg = (lo: number, hi: number) => {
            const list = adventures.filter((a) => { const t0 = new Date(a.start).getTime(); return t0 >= lo && t0 < hi; });
            return {
                km: list.reduce((n, a) => n + a.km, 0),
                n: list.length,
                terr: list.reduce((n, a) => n + a.countries.length + a.ccaa.length + a.prov.length, 0),
                peaks: list.reduce((n, a) => n + a.peaks.length, 0),
            };
        };
        return { cur: agg(mStart, now.getTime() + 60000), prev: agg(pStart, mStart), month: monthName(now.getMonth()) };
    })();
    // v1.50: el ano en numeros (vs ano anterior)
    // v1.74: estadisticas del ano por deporte
    const [yearSport, setYearSport] = useState<Sport | null>(null);
    // v1.84: ritmo mensual (barras de distancia de los ultimos 12 meses, respeta el filtro de deporte del ano)
    const monthlyBars = useMemo(() => {
        const now = new Date();
        const out: { key: string; label: string; km: number; cur: boolean }[] = [];
        for (let i = 11; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            out.push({ key: d.getFullYear() + '-' + d.getMonth(), label: monthName(d.getMonth()), km: 0, cur: i === 0 });
        }
        const idx = new Map(out.map((m, i) => [m.key, i] as [string, number]));
        for (const a of adventures) {
            if (yearSport && advSport(a) !== yearSport) continue;
            const d = new Date(a.start);
            const i = idx.get(d.getFullYear() + '-' + d.getMonth());
            if (i != null) out[i].km += a.km;
        }
        return out;
    }, [adventures, yearSport]);
    const yearStats = (() => {
        const now = new Date();
        const yStart = new Date(now.getFullYear(), 0, 1).getTime();
        const pStart = new Date(now.getFullYear() - 1, 0, 1).getTime();
        const agg = (lo: number, hi: number) => {
            const list = adventures.filter((a) => { const t0 = new Date(a.start).getTime(); return t0 >= lo && t0 < hi && (!yearSport || advSport(a) === yearSport); });
            let move = 0;
            for (const a of list) { const mv = movingStats(a); if (mv) move += mv.moveMs; }
            return {
                km: list.reduce((n, a) => n + a.km, 0),
                n: list.length,
                terr: list.reduce((n, a) => n + a.countries.length + a.ccaa.length + a.prov.length, 0),
                peaks: list.reduce((n, a) => n + a.peaks.length, 0),
                up: list.reduce((n, a) => n + (a.profile?.up || 0), 0),
                move,
            };
        };
        return { cur: agg(yStart, now.getTime() + 60000), prev: agg(pStart, yStart), year: now.getFullYear() };
    })();
    // v1.53: records personales
    // v1.70: records por deporte
    const [recSport, setRecSport] = useState<Sport | null>(null);
    const records = (() => {
        if (!adventures.length) return null;
        const recList = recSport ? adventures.filter((a) => advSport(a) === recSport) : adventures;
        if (!recList.length) return null;
        const byDay = new Map<string, { terr: number; first: Adventure }>();
        let larga: Adventure | null = null, desnivel: Adventure | null = null, ritmo: { a: Adventure; pace: number } | null = null;
        for (const a of recList) {
            if (!larga || a.km > larga.km) larga = a;
            if ((a.profile?.up || 0) > (desnivel?.profile?.up || 0)) desnivel = a;
            const ps = paceStats(a, imp);
            if (ps && (!ritmo || ps.avg < ritmo.pace)) ritmo = { a, pace: ps.avg };
            const day = a.start.slice(0, 10);
            const terr = a.countries.length + a.ccaa.length + a.prov.length;
            const cur = byDay.get(day);
            if (!cur) byDay.set(day, { terr, first: a });
            else cur.terr += terr;
        }
        let diaBest: { day: string; terr: number; first: Adventure } | null = null;
        for (const [day, v] of byDay) if (v.terr > 0 && (!diaBest || v.terr > diaBest.terr)) diaBest = { day, terr: v.terr, first: v.first };
        return { larga, desnivel, ritmo, diaBest };
    })();
    // v1.55: ritmo de la semana vs la pasada a estas alturas
    const weekKmCmp = (() => {
        const now = new Date();
        const dow = (now.getDay() + 6) % 7;
        const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow).getTime();
        const elapsed = now.getTime() - mon;
        const prev = mon - 7 * 86400000;
        let cur = 0, ant = 0;
        for (const a of adventures) {
            const t0 = new Date(a.start).getTime();
            if (t0 >= mon && t0 <= now.getTime()) cur += a.km;
            else if (t0 >= prev && t0 <= prev + elapsed) ant += a.km;
        }
        return { cur, ant };
    })();
    // v1.62: objetivo semanal de distancia (opcional; se configura en Ajustes)
    const [weekKmDone, setWeekKmDone] = useState<string>(() => loadJson<string>(WEEKKM_DONE_KEY) || '');
    useEffect(() => {
        const goal = prefs.weekKm || 0;
        if (goal <= 0) return;
        const wk = weekKey(new Date());
        if (weekKmCmp.cur >= goal && weekKmDone !== wk) {
            setWeekKmDone(wk); saveJson(WEEKKM_DONE_KEY, wk);
            setCelebration((c) => [...c, { id: 'weekkm-' + wk, ico: '🏅', title: t('Objetivo de distancia cumplido'), hint: t('Has recorrido {km} esta semana', { km: fmtDist(weekKmCmp.cur) }), test: () => true }]);
        }
    }, [weekKmCmp.cur, prefs.weekKm]);
    // v1.65: resumen de la semana pasada al primer arranque de la semana
    const RECAP_KEY = 'terraunlock.weekrecap.v1';
    const [recap, setRecap] = useState<{ km: number; advs: number; terr: number; peaks: number } | null>(null);
    useEffect(() => {
        if (loadJson<string>(RECAP_KEY) === weekKey(new Date())) return;
        const now = new Date();
        const dow = (now.getDay() + 6) % 7;
        const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow).getTime();
        const prevMon = mon - 7 * 86400000;
        let km = 0, advs = 0; const tc = new Set<string>(), ta = new Set<string>(), tp = new Set<string>(); const peaks = new Set<string>();
        for (const a of adventures) {
            const t0 = new Date(a.start).getTime();
            if (t0 >= prevMon && t0 < mon) {
                km += a.km; advs += 1;
                // v1.76: mismo conteo que la tarjeta (nombres unicos por nivel: pais + CCAA + provincia)
                for (const n of a.countries) tc.add(n);
                for (const n of a.ccaa) ta.add(n);
                for (const n of a.prov) tp.add(n);
                for (const p of a.peaks) peaks.add(p);
            }
        }
        saveJson(RECAP_KEY, weekKey(new Date()));
        if (km > 0) setRecap({ km, advs, terr: tc.size + ta.size + tp.size, peaks: peaks.size });
    }, []);
    // v1.68: resumen del mes pasado al primer arranque del mes
    const MRECAP_KEY = 'terraunlock.monthrecap.v1';
    const [mrecap, setMrecap] = useState<{ km: number; advs: number; terr: number; peaks: number; month: string } | null>(null);
    // v1.81: Escape cierra la capa superior (la ultima del DOM pinta encima)
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            if (advSummary) { setAdvSummary(null); return; }
            if (importBatch) { setImportBatch(null); return; }
            if (celebration.length) { setCelebration([]); return; }
            if (recap) { setRecap(null); return; }
            if (mrecap) { setMrecap(null); return; }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [advSummary, importBatch, celebration, recap, mrecap]);
    // v1.85: foco en dialogos - al abrir va al boton principal y Tab queda atrapado dentro
    const dialogOpen = advSummary || importBatch || celebration.length || recap || mrecap;
    useEffect(() => {
        if (!dialogOpen) return;
        const dlg = () => { const all = document.querySelectorAll('.tu-celebration[role="dialog"]'); return all.length ? all[all.length - 1] : null; };
        const d0 = dlg();
        const primary = d0?.querySelector('button[data-variant="primary"]') as HTMLElement | null;
        const anyBtn = d0?.querySelector('button') as HTMLElement | null;
        (primary || anyBtn)?.focus();
        const onTab = (e: KeyboardEvent) => {
            if (e.key !== 'Tab') return;
            const d = dlg(); if (!d) return;
            const items = [...d.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
            if (!items.length) return;
            const first = items[0], last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        };
        window.addEventListener('keydown', onTab);
        return () => window.removeEventListener('keydown', onTab);
    }, [dialogOpen]);
    useEffect(() => {
        const now = new Date();
        const mKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
        if (loadJson<string>(MRECAP_KEY) === mKey) return;
        const first = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        const prevFirst = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
        let km = 0, advs = 0; const tc = new Set<string>(), ta = new Set<string>(), tp = new Set<string>(); const peaks = new Set<string>();
        for (const a of adventures) {
            const t0 = new Date(a.start).getTime();
            if (t0 >= prevFirst && t0 < first) {
                km += a.km; advs += 1;
                // v1.76: mismo conteo que la tarjeta (nombres unicos por nivel)
                for (const n of a.countries) tc.add(n);
                for (const n of a.ccaa) ta.add(n);
                for (const n of a.prov) tp.add(n);
                for (const p of a.peaks) peaks.add(p);
            }
        }
        saveJson(MRECAP_KEY, mKey);
        if (km > 0) setMrecap({ km, advs, terr: tc.size + ta.size + tp.size, peaks: peaks.size, month: monthName(new Date(now.getFullYear(), now.getMonth() - 1, 1).getMonth()) });
    }, []);
    // v1.58: progreso hacia los logros bloqueados numericos
    const achProgress = useMemo(() => {
        let kmTot = 0, upTot = 0;
        const sports = new Set<Sport>();
        for (const a of adventures) { const sp = advSport(a); if (sp) sports.add(sp); kmTot += a.km; upTot += a.profile?.up || 0; }
        const km2 = progress.cells.length * 1.1;
        return {
            'km-10': [km2, 10], 'km-100': [km2, 100], 'km-1000': [km2, 1000],
            'country-5': [progress.countries.length, 5], 'country-10': [progress.countries.length, 10], 'country-25': [progress.countries.length, 25],
            'ccaa-19': [progress.ccaa.length, 19],
            'peak-10': [progress.peaks.length, 10], 'peak-25': [progress.peaks.length, 25],
            'points-100': [progress.points.length, 100], 'points-1000': [progress.points.length, 1000],
            'streak-3': [streak.count, 3], 'streak-7': [streak.count, 7],
            'multi-3': [sports.size, 3],
            'wstreak-2': [weekStreak.count, 2], 'wstreak-4': [weekStreak.count, 4], 'wstreak-8': [weekStreak.count, 8], 'wstreak-12': [weekStreak.count, 12],
            'dist-50': [kmTot, 50], 'dist-250': [kmTot, 250], 'dist-1000': [kmTot, 1000],
            'up-1000': [upTot, 1000], 'up-5000': [upTot, 5000], 'up-8848': [upTot, 8848],
        } as Record<string, [number, number]>;
    }, [adventures, progress, streak, weekStreak]);
    // v1.87: siguiente logro mas cercano (tarjeta de inicio)
    const nextAch = useMemo(() => {
        let best: { a: Achievement; cur: number; tgt: number } | null = null;
        for (const a of ACHIEVEMENTS) {
            if (achUnlocked[a.id]) continue;
            const pr = achProgress[a.id] as [number, number] | undefined;
            if (!pr || !pr[1]) continue;
            const ratio = pr[0] / pr[1];
            if (ratio <= 0) continue;
            if (!best || ratio > best.cur / best.tgt) best = { a, cur: pr[0], tgt: pr[1] };
        }
        return best;
    }, [achUnlocked, achProgress]);

    return <div className="tu-app">
        {tab === 'inicio' ? <>
            <section className="tu-hero">
                <MiniWorld cells={progress.cells} countries={progress.countries} />
                <div className="tu-hero-overlay">
                    <h1 className="tu-hero-title">{avatar ? <img className="tu-avatar-sm" src={avatar} alt="" /> : null}{prefs.nombre ? t('Hola, {nombre}', { nombre: prefs.nombre }) : 'TerraUnlock'}</h1>
                    <div className="tu-hero-stats">
                        <span><b>{fmtAreaShort(progress.cells.length * 1.1)}</b><small>{t('revelados')}</small></span>
                        <span><b>{progress.countries.length}</b><small>{t('Paises').toLowerCase()}</small></span>
                        <span><b>{progress.peaks.length}</b><small>{t('Cimas').toLowerCase()}</small></span>
                        {streak.count >= 2 ? <span><b>{streak.count}</b><small>{t('dias seguidos')}</small></span> : null}
                    </div>
                </div>
            </section>

            {adv ? <div className="tu-callout tu-advpanel">
                <strong>{t('Aventura en curso')}</strong>
                <p>{t('{km} - {elapsed} - {n} puntos - +{c} paises, +{a} CCAA, +{p} prov, +{k} cimas', { km: fmtDist(adv.km), elapsed: advElapsed, n: adv.points, c: progress.countries.length - adv.countries0.length, a: progress.ccaa.length - adv.ccaa0.length, p: progress.prov.length - adv.prov0.length, k: progress.peaks.length - adv.peaks0.length }).replace(/ - /g, ' · ')}</p>
                <div className="tu-controls"><button className="file-button is-compact" data-variant="primary" onClick={endAdventure}>{t('Terminar aventura')}</button><button className="file-button is-compact" data-variant="secondary" onClick={() => setTab('mapa')}>{t('Ir al mapa')}</button></div>
            </div> : <button className="tu-cta" onClick={() => { if (!gpsOn) setGpsOn(true); startAdventure(); setTab('mapa'); }}><span className="tu-cta-ico">▶</span>{t('Empezar aventura')}</button>}

            {nextAch ? <section className="tu-group">
                <h2>{t('Siguiente logro')}</h2>
                <div className="tu-nextach-body">
                    <strong>{'★ '}{t(nextAch.a.title)}</strong>
                    <small className="tu-dim">{t(nextAch.a.hint)}</small>
                    <div className="tu-bar tu-nextach-bar"><div style={{ display: 'block', height: '100%', borderRadius: 3, background: '#2dc8aa', width: Math.min(100, nextAch.cur / nextAch.tgt * 100).toFixed(0) + '%' }} /></div>
                    <small className="tu-dim">{Number.isInteger(nextAch.cur) ? String(Math.min(nextAch.cur, nextAch.tgt)) : dec(Math.min(nextAch.cur, nextAch.tgt), 1)}/{nextAch.tgt}</small>
                </div>
            </section> : null}

            {(() => {
                const terr = Math.max(0, progress.countries.length + progress.ccaa.length + progress.prov.length - weekly.countries0.length - weekly.ccaa0.length - weekly.prov0.length);
                const peaks = Math.max(0, progress.peaks.length - weekly.peaks0.length);
                const done = terr >= WEEK_TERR || peaks >= WEEK_PEAK;
                return <section className="tu-group">
                    <h2>{done ? t('Objetivo semanal cumplido') : t('Objetivo de la semana')}</h2>
                    <div className="tu-weekbars">
                        <span className="tu-weeklbl">{t('Territorios')} {Math.min(terr, WEEK_TERR)}/{WEEK_TERR}</span>
                        <span className="tu-bar"><span style={{ display: 'block', height: '100%', borderRadius: 3, background: '#2dc8aa', width: Math.min(100, terr / WEEK_TERR * 100).toFixed(0) + '%' }} /></span>
                        <span className="tu-weeklbl">{t('Cimas')} {Math.min(peaks, WEEK_PEAK)}/{WEEK_PEAK}</span>
                        <span className="tu-bar"><span style={{ display: 'block', height: '100%', borderRadius: 3, background: '#e8cd6e', width: Math.min(100, peaks / WEEK_PEAK * 100).toFixed(0) + '%' }} /></span>
                        {(prefs.weekKm || 0) > 0 ? <>
                            <span className="tu-weeklbl">{t('Distancia')} {fmtDist(Math.min(weekKmCmp.cur, prefs.weekKm || 0))}/{fmtDist(prefs.weekKm || 0)}</span>
                            <span className="tu-bar"><span style={{ display: 'block', height: '100%', borderRadius: 3, background: '#8fb8d8', width: Math.min(100, weekKmCmp.cur / (prefs.weekKm || 1) * 100).toFixed(0) + '%' }} /></span>
                        </> : null}
                    </div>
                </section>; })()}

            <div className="tu-controls tu-home-actions">
                <button className="file-button is-compact" data-variant="secondary" onClick={() => shareCard()}>{t('Compartir mi mapa')}</button>
                <button className="file-button is-compact" data-variant="secondary" onClick={() => setTab('progreso')}>{t('Ver mi progreso')}</button>
            </div>
        </> : null}

        {tab === 'mapa' ? <>
            <header className="tu-header">
                <div className="tu-header-row"><h1 className="tu-h1-av">{avatar ? <img className="tu-avatar-sm" src={avatar} alt="" /> : null}{prefs.nombre ? t('Hola, {nombre}', { nombre: prefs.nombre }) : 'TerraUnlock'}</h1><span className="tu-fact">{t('{km2} revelados', { km2: fmtAreaShort(progress.cells.length * 1.1) })}</span>{streak.count >= 2 ? <span className="tu-streak">{t('Racha: {n} dias', { n: streak.count })}</span> : null}</div>
            </header>

        <div className="tu-mapwrap" ref={wrapRef}>
            <canvas
                ref={canvasRef}
                className="tu-canvas"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
            />
            <div className="tu-hud">
                <span>{t('Paises')} {progress.countries.length}/{COUNTRIES.length}</span>
                <span>CCAA {progress.ccaa.length}/{CCAA.length}</span>
                <span>{t('Prov')} {progress.prov.length}/{PROV.length}</span>
                <span>{t('Cimas')} {progress.peaks.length}</span>
            </div>
            {nearestPeak ? <div className="tu-peaknear">{'▲'} {nearestPeak.p[0]} · {fmtDist(nearestPeak.d / 1000)}</div> : null}
            {scaleBar ? <div className="tu-scalebar"><span>{scaleBar.label}</span><i style={{ width: scaleBar.w }} /></div> : null}
            {focusAdv ? <div className="tu-focuschip">
                <span>{focusAdv.name || t('Aventura')} · {fmtDist(focusAdv.km)}</span>
                <button onClick={() => setFocusAdv(null)} aria-label={t('Cerrar')}>✕</button>
            </div> : null}
            <div className="tu-attr">Esri, Maxar, Earthstar Geographics</div>
        </div>

        <div className="tu-controls">
            <button className="file-button is-compact" data-variant={gpsOn ? 'primary' : 'secondary'} onClick={() => setGpsOn(!gpsOn)}>{gpsOn ? t('GPS activado') : t('Activar GPS')}</button>
            <button className="file-button is-compact" data-variant="secondary" onClick={centerOnMe}>{t('Centrar en mi')}</button>
            <button className="file-button is-compact" data-variant={simMode ? 'primary' : 'secondary'} onClick={() => setSimMode(!simMode)}>{simMode ? t('Modo prueba: ON') : t('Modo prueba')}</button>
            <button className="file-button is-compact" data-variant={prefs.routes ? 'primary' : 'secondary'} onClick={() => setPrefs({ routes: !prefs.routes })}>{prefs.routes ? t('Rutas: ON') : t('Rutas')}</button>
            <button className="file-button is-compact" data-variant="secondary" aria-label={t('Acercar el mapa')} onClick={() => zoomAt((wrapRef.current?.clientWidth || 0) / 2, (wrapRef.current?.clientHeight || 0) / 2, 1)}>+</button>
            <button className="file-button is-compact" data-variant="secondary" aria-label={t('Alejar el mapa')} onClick={() => zoomAt((wrapRef.current?.clientWidth || 0) / 2, (wrapRef.current?.clientHeight || 0) / 2, -1)}>-</button>
            {!adv ? <button className="file-button is-compact" data-variant="primary" onClick={startAdventure}>{t('Empezar aventura')}</button> : null}
        </div>

        {(() => {
            const terr = Math.max(0, progress.countries.length + progress.ccaa.length + progress.prov.length - weekly.countries0.length - weekly.ccaa0.length - weekly.prov0.length);
            const peaks = Math.max(0, progress.peaks.length - weekly.peaks0.length);
            const done = terr >= WEEK_TERR || peaks >= WEEK_PEAK;
            const left = daysLeftThisWeek(new Date());
            const newRegs: { rg: Region; stroke: string }[] = [];
            for (const n of progress.countries) { if (!weekly.countries0.includes(n)) { const rg = COUNTRIES.find((r) => r.n === n); if (rg) newRegs.push({ rg, stroke: '#7ee0c8' }); } }
            for (const n of progress.ccaa) { if (!weekly.ccaa0.includes(n)) { const rg = CCAA.find((r) => r.n === n); if (rg) newRegs.push({ rg, stroke: '#e8cd6e' }); } }
            for (const n of progress.prov) { if (!weekly.prov0.includes(n)) { const rg = PROV.find((r) => r.n === n); if (rg) newRegs.push({ rg, stroke: '#8fb8d8' }); } }
            return <div className={done ? 'tu-callout tu-week done' : 'tu-callout tu-week'}>
                <strong>{done ? t('Objetivo semanal cumplido') : t('Objetivo de la semana')} <small style={{ fontWeight: 400, opacity: 0.75 }}>{done ? t('a por la siguiente') : left === 0 ? t('hoy es el ultimo dia') : t(left === 1 ? 'quedan 1 dia' : 'quedan {n} dias', { n: left })}{weekStreak.count > 0 ? t(weekStreak.count === 1 ? ' - racha: {n} semana' : ' - racha: {n} semanas', { n: weekStreak.count }) : ''}</small></strong>
                <p>{t('Desbloquea {t} territorios nuevos o conquista {p} cima antes del lunes.', { t: WEEK_TERR, p: WEEK_PEAK })}</p>
                {(weekKmCmp.cur > 0 || weekKmCmp.ant > 0) ? <p className="tu-more">{t('Llevas {a} esta semana - la pasada a estas alturas: {b}', { a: fmtDist(weekKmCmp.cur), b: fmtDist(weekKmCmp.ant) })}</p> : null}
                <div className="tu-weekbars">
                    <span className="tu-weeklbl">{t('Territorios')} {Math.min(terr, WEEK_TERR)}/{WEEK_TERR}</span>
                    <span className="tu-bar"><span style={{ display: 'block', height: '100%', borderRadius: 3, background: '#2dc8aa', width: Math.min(100, terr / WEEK_TERR * 100).toFixed(0) + '%' }} /></span>
                    <span className="tu-weeklbl">{t('Cimas')} {Math.min(peaks, WEEK_PEAK)}/{WEEK_PEAK}</span>
                    <span className="tu-bar"><span style={{ display: 'block', height: '100%', borderRadius: 3, background: '#e8cd6e', width: Math.min(100, peaks / WEEK_PEAK * 100).toFixed(0) + '%' }} /></span>
                    {(prefs.weekKm || 0) > 0 ? <>
                        <span className="tu-weeklbl">{t('Distancia')} {fmtDist(Math.min(weekKmCmp.cur, prefs.weekKm || 0))}/{fmtDist(prefs.weekKm || 0)}</span>
                        <span className="tu-bar"><span style={{ display: 'block', height: '100%', borderRadius: 3, background: '#8fb8d8', width: Math.min(100, weekKmCmp.cur / (prefs.weekKm || 1) * 100).toFixed(0) + '%' }} /></span>
                    </> : null}
                </div>
                {newRegs.length ? <div className="tu-weekshapes">
                    {newRegs.slice(0, 6).map(({ rg, stroke }) => (
                        <button key={rg.n} className="tu-weekshape" title={rg.n} onClick={() => setViewPersist({ lon: rg.c[0], lat: rg.c[1], z: regionZoom(rg) })}>
                            <WeekShape rg={rg} stroke={stroke} />
                            <span>{rg.n}</span>
                        </button>
                    ))}
                    {newRegs.length > 6 ? <span className="tu-weekmore">{t('+{n} mas', { n: newRegs.length - 6 })}</span> : null}
                </div> : null}
                <div className="tu-controls" style={{ marginTop: 8 }}><button className="file-button is-compact" data-variant="secondary" onClick={shareWeekCard}>{t('Compartir mi semana')}</button></div>
            </div>;
        })()}

        {adv ? <div className="tu-callout tu-advpanel">
            <strong>{t('Aventura en curso')}</strong>
            <p>{t('{km} - {elapsed} - {n} puntos - +{c} paises, +{a} CCAA, +{p} prov, +{k} cimas', { km: fmtDist(adv.km), elapsed: advElapsed, n: adv.points, c: progress.countries.length - adv.countries0.length, a: progress.ccaa.length - adv.ccaa0.length, p: progress.prov.length - adv.prov0.length, k: progress.peaks.length - adv.peaks0.length }).replace(/ - /g, ' · ')}</p>
            <div className="tu-controls"><button className="file-button is-compact" data-variant="primary" onClick={endAdventure}>{t('Terminar aventura')}</button></div>
        </div> : null}
        {gpsMsg ? <div className="tu-callout tu-warn"><strong>GPS</strong><p>{gpsMsg}</p></div> : null}
        {simMode ? <div className="tu-callout"><strong>{t('Modo prueba')}</strong><p>{t('Toca cualquier punto del mapa para simular que has estado ahi: revela niebla y desbloquea igual que el GPS.')}</p></div> : null}


        <section className="tu-group"><h2>{t('Te falta cerca')}</h2>
            <p className="tu-more">{t('Sin conquistar en 150 km {origen}.', { origen: lastPos ? t('desde tu posicion') : t('desde el centro del mapa') })}</p>
            {nearMissing.length ? (
                <ol className="tu-miss">
                    {nearMissing.map((m) => (
                        <li key={m.level + m.name}>
                            <button className="tu-missrow" onClick={() => { setSelectedPeak(null); setViewPersist({ lon: m.lon, lat: m.lat, z: m.level === 'Provincia' ? 8 : 6 }); }}>
                                <b>{m.name}</b>
                                <span>{t(m.level)} · {m.d < 2000 ? t('aqui mismo') : fmtDist(m.d / 1000)} · {m.dir}</span>
                            </button>
                        </li>
                    ))}
                </ol>
            ) : <div className="tu-callout"><strong>{t('Zona dominada')}</strong><p>{t('No te queda nada sin conquistar en 150 km a la redonda.')}</p></div>}
        </section>

        {selectedPeak ? (
            <div className="tu-callout">
                <strong>{selectedPeak[0]} <small style={{ fontWeight: 400, opacity: 0.75 }}>{selectedPeak[3]} m</small></strong>
                <p>{progress.peaks.includes(peakId(selectedPeak))
                    ? t('Cima conquistada. Buen trabajo.')
                    : t('Aun sin conquistar: pasa a menos de 1 km de la cima para que cuente.')}</p>
                <div className="tu-controls">
                    <a className="file-button is-compact" data-variant="primary" href={wikilocMapUrl(selectedPeak)} target="_blank" rel="noopener noreferrer">{t('Rutas en Wikiloc')}</a>
                    <a className="file-button is-compact" data-variant="secondary" href={'https://www.google.com/maps/dir/?api=1&destination=' + selectedPeak[1] + ',' + selectedPeak[2]} target="_blank" rel="noopener noreferrer">{t('Como llegar')}</a>
                    <button className="file-button is-compact" data-variant="secondary" onClick={() => setSelectedPeak(null)}>{t('Cerrar')}</button>
                </div>
                <TerrainCard peak={selectedPeak} />
            </div>
        ) : null}

        {selectedRegion ? (
            <div className="tu-callout">
                <strong>{selectedRegion.pv || selectedRegion.a || selectedRegion.c}</strong>
                <div>{([
                    [t('Pais'), selectedRegion.c, COUNTRIES.find((r) => r.n === selectedRegion.c), progress.countries],
                    [t('Comunidad'), selectedRegion.a, CCAA.find((r) => r.n === selectedRegion.a), progress.ccaa],
                    [t('Provincia'), selectedRegion.pv, PROV.find((r) => r.n === selectedRegion.pv), progress.prov],
                ] as [string, string | null, Region | undefined, string[]][]).map(([lvl, name, rg, unlocked]) => {
                    if (!name || !rg) return null;
                    const rev = regionRevealedCells(rg, progress.cells);
                    const pct = Math.min(100, rev / regionTotalCells(rg) * 100);
                    return <div key={lvl} className="tu-regionrow">
                        <span className="tu-regionlvl">{lvl}</span>
                        <span className="tu-regionname">{name}</span>
                        <span className={unlocked.includes(name) ? 'tu-regionst on' : 'tu-regionst'}>{unlocked.includes(name) ? t('Conquistada') : t('Sin conquistar')}</span>
                        {rev > 0 ? <span className="tu-regionpct">{t('{pct}% revelado', { pct: dec(pct) })}</span> : null}
                    </div>;
                })}</div>
                {(() => {
                    const a = selectedRegion.a, pv = selectedRegion.pv, c = selectedRegion.c;
                    const rgPv = pv ? PROV.find((r) => r.n === pv) : null;
                    const rgA = a ? CCAA.find((r) => r.n === a) : null;
                    const rgC = c ? COUNTRIES.find((r) => r.n === c) : null;
                    const rgAny = rgPv || rgA || rgC;
                    if (rgPv) {
                        const inside = peaksInRegion(rgPv, allPeaks);
                        const rest = inside.filter((p) => !progress.peaks.includes(peakId(p))).sort((x, y) => y[3] - x[3]);
                        return <div className="tu-break">
                            <RegionShape rg={rgPv} cells={progress.cells} />
                            <div className="tu-breaktitle">{t('Cimas en {n}: {won} de {total} conquistadas', { n: rgPv.n, won: inside.length - rest.length, total: inside.length })}</div>
                            {rest.length ? <ol className="tu-peaklist">{rest.slice(0, 6).map((p) => <li key={peakId(p)}>
                                <span className="tu-pkname">{p[0]}</span><span className="tu-pkele">{p[3]} m</span>
                                <button className="file-button is-compact" data-variant="secondary" onClick={() => showPeakOnMap(p)}>{t('Ver')}</button>
                            </li>)}</ol> : null}
                            {!rest.length && inside.length ? <div className="tu-terrnote">{t('Todas las cimas de la provincia conquistadas.')}</div> : null}
                            {!inside.length ? <div className="tu-terrnote">{t('No hay cimas del catalogo en esta provincia.')}</div> : null}
                            {rest.length > 6 ? <div className="tu-terrnote">{t('y {n} mas sin conquistar', { n: rest.length - 6 })}</div> : null}
                        </div>;
                    }
                    const lista = rgA ? PROV.filter((p) => provToCcaa(p) === rgA.n).map((p) => ({ rg: p, won: progress.prov.includes(p.n), z: 8, go: () => { setSelectedRegion({ c, a, pv: p.n }); setViewPersist({ lon: p.c[0], lat: p.c[1], z: 8 }); } }))
                        : rgC && rgC.n === 'España' ? CCAA.map((g) => ({ rg: g, won: progress.ccaa.includes(g.n), z: 6, go: () => { setSelectedRegion({ c, a: g.n, pv: null }); setViewPersist({ lon: g.c[0], lat: g.c[1], z: 6 }); } }))
                        : null;
                    if (lista) {
                        const titulo = rgA ? t('Provincias de {n}', { n: rgA.n }) : t('Comunidades de España');
                        return <div className="tu-break">
                            {rgAny ? <RegionShape rg={rgAny} cells={progress.cells} /> : null}
                            <div className="tu-breaktitle">{t('{titulo}: {won} de {total} conquistadas', { titulo, won: lista.filter((x) => x.won).length, total: lista.length })}</div>
                            {lista.map((x) => {
                                const rev = regionRevealedCells(x.rg, progress.cells);
                                const pct = Math.min(100, rev / regionTotalCells(x.rg) * 100);
                                return <button key={x.rg.n} className="tu-breakrow" onClick={x.go}>
                                    <span className="tu-breakname">{x.rg.n}</span>
                                    <span className={x.won ? 'tu-regionst on' : 'tu-regionst'}>{x.won ? t('Conquistada') : t('{pct}% revelado', { pct: dec(pct) })}</span>
                                    <span className="tu-bar"><span style={{ display: 'block', height: '100%', borderRadius: 3, background: '#2dc8aa', width: Math.max(pct, pct > 0 ? 2 : 0).toFixed(1) + '%' }} /></span>
                                </button>;
                            })}
                        </div>;
                    }
                    if (rgC) {
                        const inside = peaksInRegion(rgC, allPeaks);
                        const rest = inside.filter((p) => !progress.peaks.includes(peakId(p))).sort((x, y) => y[3] - x[3]);
                        return <div className="tu-break">
                            <RegionShape rg={rgC} cells={progress.cells} />
                            <div className="tu-breaktitle">{t('Cimas en {n}: {won} de {total} conquistadas', { n: rgC.n, won: inside.length - rest.length, total: inside.length })}</div>
                            {rest.length ? <ol className="tu-peaklist">{rest.slice(0, 6).map((p) => <li key={peakId(p)}>
                                <span className="tu-pkname">{p[0]}</span><span className="tu-pkele">{p[3]} m</span>
                                <button className="file-button is-compact" data-variant="secondary" onClick={() => showPeakOnMap(p)}>{t('Ver')}</button>
                            </li>)}</ol> : null}
                            {rest.length > 6 ? <div className="tu-terrnote">{t('y {n} mas sin conquistar', { n: rest.length - 6 })}</div> : null}
                        </div>;
                    }
                    return null;
                })()}
                <div className="tu-controls">
                    {(() => {
                        const rg = selectedRegion.pv ? PROV.find((r) => r.n === selectedRegion.pv) : selectedRegion.a ? CCAA.find((r) => r.n === selectedRegion.a) : COUNTRIES.find((r) => r.n === selectedRegion.c);
                        const lvl = selectedRegion.pv ? t('Provincia') : selectedRegion.a ? t('Comunidad') : t('Pais');
                        return rg ? <button className="file-button is-compact" data-variant="primary" onClick={() => shareRegionCard(rg, lvl)}>{t('Compartir')}</button> : null;
                    })()}
                    <button className="file-button is-compact" data-variant="secondary" onClick={() => setSelectedRegion(null)}>{t('Cerrar')}</button>
                </div>
            </div>
        ) : null}
        </> : null}

        {tab === 'progreso' ? <>
            <section className="tu-group"><h2>{t('Tu progreso')}</h2>
                <dl className="tu-factsdl">{([
                    { label: t('Superficie revelada'), value: '~' + fmtAreaShort(progress.cells.length * 1.1), pct: null },
                    { label: t('Paises'), value: t('{n} de {total}', { n: progress.countries.length, total: COUNTRIES.length }) + ' (' + dec(progress.countries.length / COUNTRIES.length * 100) + '%)', pct: progress.countries.length / COUNTRIES.length },
                    { label: t('Comunidades (ES)'), value: t('{n} de {total}', { n: progress.ccaa.length, total: CCAA.length }) + ' (' + dec(progress.ccaa.length / CCAA.length * 100) + '%)', pct: progress.ccaa.length / CCAA.length },
                    { label: t('Provincias (ES)'), value: t('{n} de {total}', { n: progress.prov.length, total: PROV.length }) + ' (' + dec(progress.prov.length / PROV.length * 100) + '%)', pct: progress.prov.length / PROV.length },
                    { label: t('Cimas conquistadas'), value: t('{n} de {total}', { n: progress.peaks.length, total: allPeaks.length }), pct: allPeaks.length > 0 ? progress.peaks.length / allPeaks.length : 0 },
                    { label: t('Puntos GPS'), value: String(progress.points.length), pct: null },
                    { label: t('Racha'), value: streak.count > 0 ? t(streak.count === 1 ? '{n} dia' : '{n} dias', { n: streak.count }) : '-', pct: null },
                    { label: t('Tiempo en movimiento'), value: totalStats.n ? fmtDurTotal(totalStats.ms) : '-', pct: null },
                    { label: t('Desnivel acumulado'), value: totalStats.profN ? '+' + Math.round(totalStats.up) + ' m' : '-', pct: null },
                ] as { label: string; value: string; pct: number | null }[]).map((f) => <div key={f.label} className="tu-factrow"><dt>{f.label}</dt><dd>{f.value}</dd>{f.pct != null ? <div className="tu-bar"><div style={{ width: Math.max(f.pct * 100, f.pct > 0 ? 2 : 0).toFixed(1) + '%' }} /></div> : null}</div>)}</dl>
                {sportChips.length ? <div className="tu-sportrow"><small>{t('Por deporte')}</small>{sportChips.map((sc2) => <span key={sc2.s} className="tu-sportchip">{sportEmoji(sc2.s)} {fmtDist(sc2.km)} · {sc2.n}</span>)}</div> : null}
                <div className="tu-controls"><button className="file-button" data-variant="primary" onClick={shareCard}>{t('Compartir mi mapa')}</button><button className="file-button" data-variant="primary" onClick={shareWeekCard}>{t('Compartir mi semana')}</button></div>
            </section>

            <section className="tu-group"><h2>{t('Este mes')} · {monthStats.month}</h2>
                <dl className="tu-factsdl">{([
                    { label: t('Distancia'), value: fmtDist(monthStats.cur.km), prev: fmtDist(monthStats.prev.km) },
                    { label: t('Aventuras'), value: String(monthStats.cur.n), prev: String(monthStats.prev.n) },
                    { label: t('Territorios nuevos'), value: String(monthStats.cur.terr), prev: String(monthStats.prev.terr) },
                    { label: t('Cimas'), value: String(monthStats.cur.peaks), prev: String(monthStats.prev.peaks) },
                ]).map((f) => <div key={f.label} className="tu-factrow"><dt>{f.label}</dt><dd>{f.value} <small style={{ fontWeight: 400, opacity: 0.6 }}>{t('{v} el mes pasado', { v: f.prev })}</small></dd></div>)}</dl>
                <div className="tu-controls"><button className="file-button" data-variant="primary" onClick={shareMonthCard}>{t('Compartir mi mes')}</button></div>
            </section>

            {yearStats.cur.n || (yearSport && sportsPresent.length > 1) ? <section className="tu-group"><h2>{t('Este ano')} · {yearStats.year}</h2>
                {sportsPresent.length > 1 ? <div className="tu-sportrow" style={{ marginBottom: 8 }}>
                    <Chip on={yearSport === null} label={t('Todos')} onPick={() => setYearSport(null)} />
                    {sportsPresent.map((sp) => <Chip key={sp} on={yearSport === sp} label={sportEmoji(sp)} onPick={() => setYearSport(yearSport === sp ? null : sp)} />)}
                </div> : null}
                {!yearStats.cur.n ? <div className="tu-callout"><strong>{t('Sin actividad de este deporte este ano')}</strong><p>{t('Todavia no hay aventuras de este tipo en {y}.', { y: yearStats.year })}</p></div> : null}
            {yearStats.cur.n ? <>
                <dl className="tu-factsdl">{([
                    { label: t('Distancia'), value: fmtDist(yearStats.cur.km), prev: fmtDist(yearStats.prev.km) },
                    { label: t('Aventuras'), value: String(yearStats.cur.n), prev: String(yearStats.prev.n) },
                    { label: t('Territorios nuevos'), value: String(yearStats.cur.terr), prev: String(yearStats.prev.terr) },
                    { label: t('Cimas'), value: String(yearStats.cur.peaks), prev: String(yearStats.prev.peaks) },
                    { label: t('Desnivel acumulado'), value: '+' + yearStats.cur.up + ' m', prev: '+' + yearStats.prev.up + ' m' },
                    ...(yearStats.cur.move ? [{ label: t('Tiempo en movimiento'), value: fmtDur(yearStats.cur.move), prev: fmtDur(yearStats.prev.move) }] : []),
                ]).map((f) => <div key={f.label} className="tu-factrow"><dt>{f.label}</dt><dd>{f.value} <small style={{ fontWeight: 400, opacity: 0.6 }}>{t('{v} el ano pasado', { v: f.prev })}</small></dd></div>)}</dl>
                <div className="tu-controls"><button className="file-button" data-variant="primary" onClick={shareYearCard}>{t('Compartir mi ano')}</button></div>
            </> : null}
            </section> : null}

            {records || (recSport && sportsPresent.length > 1) ? <section className="tu-group"><h2>{t('Records')}</h2>
                {sportsPresent.length > 1 ? <div className="tu-sportrow" style={{ marginBottom: 8 }}>
                    <Chip on={recSport === null} label={t('Todos')} onPick={() => setRecSport(null)} />
                    {sportsPresent.map((sp) => <Chip key={sp} on={recSport === sp} label={sportEmoji(sp)} onPick={() => setRecSport(recSport === sp ? null : sp)} />)}
                </div> : null}
            {!records ? <div className="tu-callout"><strong>{t('Sin records de este deporte')}</strong><p>{t('Todavia no hay aventuras de este tipo.')}</p></div> : null}
            {records ? <>
                <ol className="tu-peaklist">
                    {records.larga ? <li className="tu-advrow" onClick={() => setAdvOpen(records.larga!.start)}><span className="tu-pkname">{t('Aventura mas larga')}<small>{records.larga.name || new Date(records.larga.start).toLocaleDateString(dateLocale())}</small></span><span className="tu-pkele">{fmtDist(records.larga.km)}</span></li> : null}
                    {records.desnivel && (records.desnivel.profile?.up || 0) > 0 ? <li className="tu-advrow" onClick={() => setAdvOpen(records.desnivel!.start)}><span className="tu-pkname">{t('Mayor desnivel')}<small>{records.desnivel.name || new Date(records.desnivel.start).toLocaleDateString(dateLocale())}</small></span><span className="tu-pkele">+{records.desnivel.profile!.up} m</span></li> : null}
                    {records.ritmo ? <li className="tu-advrow" onClick={() => setAdvOpen(records.ritmo!.a.start)}><span className="tu-pkname">{t('Mejor ritmo medio')}<small>{records.ritmo.a.name || new Date(records.ritmo.a.start).toLocaleDateString(dateLocale())}</small></span><span className="tu-pkele">{fmtPace(records.ritmo.pace, imp)}</span></li> : null}
                    {records.diaBest ? <li className="tu-advrow" onClick={() => setAdvOpen(records.diaBest!.first.start)}><span className="tu-pkname">{t('Dia con mas territorios')}<small>{new Date(records.diaBest.day + 'T12:00:00').toLocaleDateString(dateLocale())}</small></span><span className="tu-pkele">+{records.diaBest.terr}</span></li> : null}
                </ol>
            </> : null}
            </section> : null}

            {monthlyBars.some((m) => m.km > 0) ? <section className="tu-group"><h2>{t('Ritmo mensual')}</h2>
                <div className="tu-mbars" role="img" aria-label={t('Distancia por mes de los ultimos 12 meses')}>
                    {(() => { const max = Math.max(0.1, ...monthlyBars.map((x) => x.km)); return monthlyBars.map((m) => (
                        <div key={m.key} className="tu-mbar" title={m.label + ': ' + dec(m.km, 1) + ' km'}>
                            <div className={'tu-mbar-fill' + (m.cur ? ' cur' : '')} style={{ height: Math.max(2, Math.round(m.km / max * 100)) + '%' }} />
                            <small>{m.label.slice(0, 1).toUpperCase()}</small>
                        </div>)); })()}
                </div>
            </section> : null}
            <section className="tu-group"><h2>{t('Actividad')}</h2>
                {adventures.length ? <>
                    {sportsPresent.length > 1 ? <div className="tu-sportrow" style={{ marginBottom: 8 }}>
                        <Chip on={heatSport === null} label={t('Todos')} onPick={() => setHeatSport(null)} />
                        {sportsPresent.map((sp) => <Chip key={sp} on={heatSport === sp} label={sportEmoji(sp)} onPick={() => setHeatSport(heatSport === sp ? null : sp)} />)}
                    </div> : null}
                    <div className="tu-heat" role="img" aria-label={t('Calendario de actividad de las ultimas 20 semanas: cada celda es un dia, mas intenso es mas distancia.')}>
                        {heatWeeks.map((w, wi) => <div key={wi} className="tu-heatcol">
                            {w.map((d, di) => d
                                ? <span key={d.k} className={'tu-heatcell lv' + d.lv} title={d.label + (d.km > 0 ? ' - ' + fmtDist(d.km) + ' - ' + t('toca para filtrar') : '')}
                                    style={d.km > 0 ? { cursor: 'pointer' } : undefined}
                                    onClick={d.km > 0 ? () => {
                                        const ds = new Date(d.k + 'T12:00:00').toLocaleDateString(dateLocale());
                                        setAdvQuery((q) => q === ds ? '' : ds);
                                        document.getElementById('tu-advsec')?.scrollIntoView({ block: 'start' });
                                    } : undefined} />
                                : <span key={wi + '-' + di} className="tu-heatcell future" />)}
                        </div>)}
                    </div>
                    <div className="tu-heatmonths">{heatMonths.map((m, i) => <span key={i}>{m}</span>)}</div>
                    <div className="tu-heatlegend"><span>{t('Menos')}</span><span className="tu-heatcell lv0" /><span className="tu-heatcell lv1" /><span className="tu-heatcell lv2" /><span className="tu-heatcell lv3" /><span>{t('Mas')}</span></div>
                    <div className="tu-controls" style={{ marginTop: 8 }}><button className="file-button" data-variant="primary" onClick={shareHeatCard}>{t('Compartir mi actividad')}</button></div>
                </> : <p className="tu-more">{t('Aun no hay actividad: tus dias con aventura apareceran aqui.')}</p>}
            </section>

            {ccaaRanking.length ? <section className="tu-group"><h2>{t('Comunidades mas dominadas')}</h2>
                <ol className="tu-peaklist tu-peaklist-full">
                    {ccaaRanking.map((r, i) => <li key={r.n}>
                        <span className="tu-num">{i + 1}</span>
                        <span className="tu-pkname">{r.n}<small>{progress.ccaa.includes(r.n) ? t('Conquistada') : t('Sin conquistar')}</small></span>
                        <span className="tu-pkele">{dec(r.pct)}%</span>
                        <button className="file-button is-compact" data-variant="secondary" onClick={() => { setSelectedPeak(null); setSelectedRegion({ c: 'España', a: r.n, pv: null }); setViewPersist({ lon: r.c[0], lat: r.c[1], z: 6 }); setTab('mapa'); }}>{t('Ver')}</button>
                    </li>)}
                </ol>
                <div className="tu-terrnote">{t('Porcentaje de superficie revelada dentro de cada comunidad. Toca "Ver" para abrirla en el mapa.')}</div>
            </section> : null}

            <section className="tu-group"><h2>{t('Logros')} <small className="tu-dim">{ACHIEVEMENTS.filter((x) => achUnlocked[x.id]).length}/{ACHIEVEMENTS.length}</small></h2>
                <div className="tu-ach-grid">
                    {ACHIEVEMENTS.map((a) => { const at = achUnlocked[a.id]; const pr = !at ? achProgress[a.id] : undefined; return (
                        <div key={a.id} className={'tu-ach' + (at ? ' on' : '')}>
                            <span className="tu-ach-ico" aria-hidden="true">{a.ico}</span>
                            <b>{t(a.title)}</b>
                            <small>{at ? new Date(at).toLocaleDateString(dateLocale()) : t(a.hint)}{pr ? ' - ' + (Number.isInteger(pr[0]) ? String(Math.min(pr[0], pr[1])) : dec(Math.min(pr[0], pr[1]), 1)) + '/' + pr[1] : ''}</small>
                            {!at && pr ? <div className="tu-bar tu-ach-bar"><div style={{ width: Math.min(100, pr[0] / pr[1] * 100).toFixed(0) + '%' }} /></div> : null}
                            {at ? <button className="tu-achshare" title={t('Compartir logro')} aria-label={t('Compartir logro')} onClick={() => { void shareAchievementCard(a); }}>↗</button> : null}
                        </div>); })}
                </div>
            </section>

            <section className="tu-group" id="tu-advsec"><h2>{t('Aventuras')}</h2>
                <div className="tu-terrnote" style={{ marginBottom: 6 }}>{adventures.length ? t('Toca una aventura para ver su perfil de elevacion.') : t('Aun no hay aventuras: empieza una desde el mapa o importa un GPX.')}</div>
                <div className="tu-controls" style={{ marginBottom: 8 }}>
                    <label className="file-button is-compact" data-variant="secondary">{t('Importar GPX como aventura')}
                        <input type="file" accept=".gpx,application/gpx+xml" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) importGpxAdventure(f); e.target.value = ''; }} />
                    </label>
                </div>
                {sportsPresent.length > 1 ? <div className="tu-sportrow" style={{ marginBottom: 8 }}>
                    <Chip on={sportFilter === null} label={t('Todos')} onPick={() => setSportFilter(null)} />
                    {sportsPresent.map((sp) => <Chip key={sp} on={sportFilter === sp} label={sportEmoji(sp) + ' ' + adventures.filter((a) => advSport(a) === sp).length} onPick={() => setSportFilter(sportFilter === sp ? null : sp)} />)}
                </div> : null}
                {adventures.length >= 3 ? <input className="tu-input tu-input-full" type="search" style={{ marginBottom: 8 }} placeholder={t('Buscar por nombre, fecha o territorio')} value={advQuery} onChange={(e) => setAdvQuery(e.target.value)} /> : null}
                {advFiltered.length > 1 ? <div className="tu-sportrow" style={{ marginBottom: 8 }}>
                    <small>{t('Ordenar')}</small>
                    {([['rec', t('Recientes')], ['km', t('Distancia')], ['up', t('Desnivel')]] as ['rec' | 'km' | 'up', string][]).map(([k, lab]) => <Chip key={k} on={advSort === k} label={lab} onPick={() => setAdvSort(k)} />)}
                </div> : null}
                {adventures.length ? <ol className="tu-peaklist tu-advlist">
                    {advShown.slice(0, advLimit).map((a) => <li key={a.start} className="tu-advrow" onClick={() => setAdvOpen(advOpen === a.start ? null : a.start)}>
                        <span className="tu-advsum">{a.track && a.track.length >= 2 ? <TrackThumb track={a.track} /> : null}
                        <span className="tu-pkname">{sportEmoji(advSport(a)) ? sportEmoji(advSport(a)) + ' ' : ''}{a.name || new Date(a.start).toLocaleDateString(dateLocale())}{a.name ? <small>{new Date(a.start).toLocaleDateString(dateLocale())}</small> : null}{a.stravaId ? <small className="tu-stravabadge">Strava</small> : null}<small>{[...a.countries, ...a.ccaa, ...a.prov].join(', ') || t('Sin desbloqueos nuevos')}</small></span></span>
                        <span className="tu-pkele">{fmtDist(a.km)}</span>
                        {advOpen === a.start ? <span className="tu-advprof" onClick={(e) => e.stopPropagation()}>{(() => { const ps = paceStats(a, imp); return ps ? <span className="tu-terrnote" style={{ display: 'block', marginBottom: 4 }}>{t('Ritmo medio {pace}', { pace: fmtPace(ps.avg, imp) })}{ps.best ? t(imp ? ' - Mejor milla {pace}' : ' - Mejor km {pace}', { pace: fmtPace(ps.best, imp) }) : ''}</span> : null; })()}{(() => { const mv = movingStats(a); return mv ? <span className="tu-terrnote" style={{ display: 'block', marginBottom: 4 }}>{t('En movimiento {dur}', { dur: fmtDur(mv.moveMs) })}{mv.pauseMs >= 60000 ? t(' - Pausas {dur}', { dur: fmtDur(mv.pauseMs) }) : ''}</span> : null; })()}<ElevChart adv={a} onProfile={saveProfile} /><PaceChart adv={a} imp={imp} /><span className="tu-controls" style={{ marginTop: 6, alignItems: 'center' }}><small className="tu-dim">{t('Deporte')}</small>{(['run', 'ride', 'walk', 'hike'] as Sport[]).map((sp) => <Chip key={sp} on={advSport(a) === sp} title={t(sp === 'run' ? 'Correr' : sp === 'ride' ? 'Ciclismo' : sp === 'walk' ? 'Caminar' : 'Senderismo')} label={sportEmoji(sp)} onPick={() => { const list = adventures.map((x) => x.start === a.start ? { ...x, sport: sp } : x); setAdventures(list); saveJson(ADVS_KEY, list); }} />)}{a.sport ? <Chip on={false} title={t('Volver a deteccion automatica')} label={t('Auto')} onPick={() => { const list = adventures.map((x) => x.start === a.start ? { ...x, sport: undefined } : x); setAdventures(list); saveJson(ADVS_KEY, list); }} /> : null}</span><span className="tu-controls" style={{ marginTop: 6 }}>{a.track && a.track.length >= 2 ? <button className="file-button is-compact" data-variant="primary" onClick={() => showAdvOnMap(a)}>{t('Ver en el mapa')}</button> : null}<button className="file-button is-compact" data-variant="secondary" onClick={() => shareAdventureCard(a)}>{t('Compartir aventura')}</button><button className="file-button is-compact" data-variant="secondary" onClick={() => exportGpx(a)}>{t('Exportar GPX')}</button><button className="file-button is-compact" data-variant="secondary" onClick={() => { const n = window.prompt(t('Nombre de la aventura'), a.name || ''); if (n !== null) { const list = adventures.map((x) => x.start === a.start ? { ...x, name: n.trim() || undefined } : x); setAdventures(list); saveJson(ADVS_KEY, list); } }}>{t('Renombrar')}</button><button className="file-button is-compact" data-variant="secondary" onClick={() => { if (window.confirm(t('Borrar esta aventura? El territorio revelado se queda como esta.'))) { const list = adventures.filter((x) => x.start !== a.start); setAdventures(list); saveJson(ADVS_KEY, list); setAdvOpen(null); offerUndoAdv(a); } }}>{t('Borrar')}</button></span></span> : null}
                    </li>)}
                </ol> : null}
                {advShown.length > advLimit ? <div className="tu-controls" style={{ marginTop: 6 }}><button className="file-button is-compact" data-variant="secondary" onClick={() => setAdvLimit((n) => n + 20)}>{t('Cargar mas ({shown} de {total})', { shown: advLimit, total: advShown.length })}</button></div> : null}
            </section>

            {progress.countries.length + progress.ccaa.length + progress.prov.length > 0 ? <section className="tu-group"><h2>{t('Territorio desbloqueado')}</h2>
                <div className="tu-chips">
                    {progress.countries.map((n) => <span key={'c' + n} className="tu-chip">{n}</span>)}
                    {progress.ccaa.map((n) => <span key={'a' + n} className="tu-chip tu-chip-2">{n}</span>)}
                    {progress.prov.map((n) => <span key={'p' + n} className="tu-chip tu-chip-3">{n}</span>)}
                </div>
            </section> : <section className="tu-group"><div className="tu-callout"><strong>{t('Aun sin territorio')}</strong><p>{t('Activa el GPS en la pestana Mapa o usa el modo prueba para desbloquear tu primera zona.')}</p></div></section>}
        </> : null}

        {tab === 'cimas' ? <>
            <section className="tu-group tu-peakhero">
                <div className="tu-hero-stats tu-peakhero-stats">
                    <span><b>{progress.peaks.length}<small className="tu-dim">/{allPeaks.length}</small></b><small>{t('Cimas conquistadas')}</small></span>
                    <span><b>{peakTop ? peakTop[3].toLocaleString(dateLocale()) + ' m' : '-'}</b><small>{peakTop ? peakTop[0] : t('Tu cima mas alta')}</small></span>
                    <span><b>{peakSumEle ? peakSumEle.toLocaleString(dateLocale()) + ' m' : '-'}</b><small>{t('Metros de cima')}</small></span>
                </div>
            </section>

            <section className="tu-group"><h2>{t('Buscar cimas')}</h2>
                <input className="tu-input tu-input-full" type="search" placeholder={t('Nombre de la cima (min. 2 letras)')} value={peakQuery} onChange={(e) => setPeakQuery(e.target.value)} />
                {peakQuery.trim().length >= 2 ? (
                    peakResults.length ? <ol className="tu-peaklist tu-peaklist-full">
                        {peakResults.map((p) => <li key={peakId(p)}>
                            <span className="tu-pkname">{p[0]}<small>{progress.peaks.includes(peakId(p)) ? t('Conquistada') : t('Sin conquistar')}</small></span>
                            <span className="tu-pkele">{p[3]} m</span>
                            <button className="file-button is-compact" data-variant="secondary" onClick={() => showPeakOnMap(p)}>{t('Ver')}</button>
                        </li>)}
                    </ol> : <div className="tu-callout"><strong>{t('Sin resultados')}</strong><p>{t('Prueba con otro nombre: el buscador ignora tildes y mayusculas.')}</p></div>
                ) : null}
            </section>

            <section className="tu-group"><h2>{t('Cerca de ti')}</h2>
                {lastPos ? (
                    nearbyPeaks.length ? <ol className="tu-peaklist">
                        {nearbyPeaks.map(({ p, d }) => <li key={peakId(p)}>
                            <span className="tu-pkname">{p[0]}<small>{progress.peaks.includes(peakId(p)) ? t('Conquistada') : t('Sin conquistar')}</small></span>
                            <span className="tu-pkele">{p[3]} m</span>
                            <span className="tu-pkdist">{fmtDist(d / 1000)}</span>
                            <button className="file-button is-compact" data-variant="secondary" onClick={() => showPeakOnMap(p)}>{t('Ver')}</button>
                        </li>)}
                    </ol> : <div className="tu-callout"><strong>{t('Nada a menos de 100 km')}</strong><p>{t('No hay cimas del catalogo cerca de tu posicion actual.')}</p></div>
                ) : <div className="tu-callout"><strong>{t('Que tengo cerca que cuente?')}</strong><p>{t('Dame tu posicion y te listo las cimas conquistables a menos de 100 km, con distancia.')}</p>
                    <div className="tu-controls"><button className="file-button is-compact" data-variant="primary" onClick={locateForNearby}>{t('Usar mi posicion')}</button></div></div>}
            </section>

            <section className="tu-group"><h2>{t('Por conquistar')}</h2>
                <div className="tu-terrnote" style={{ marginBottom: 6 }}>{t('Las 20 cimas mas altas del catalogo que aun no tienes.')}</div>
                <ol className="tu-peaklist tu-peaklist-full">
                    {pendingTopPeaks.map((p, i) => <li key={peakId(p)}>
                        <span className="tu-num">{i + 1}</span>
                        <span className="tu-pkname">{p[0]}</span>
                        <span className="tu-pkele">{p[3]} m</span>
                        <button className="file-button is-compact" data-variant="secondary" onClick={() => showPeakOnMap(p)}>{t('Ver')}</button>
                    </li>)}
                </ol>
            </section>

            <section className="tu-group"><h2>{t('Tus cimas')}</h2>
                <div className="tu-callout"><strong>{t('{won} de {total} conquistadas', { won: progress.peaks.length, total: allPeaks.length })}</strong><p>{t('Toca cualquier triangulo del mapa para ver su ficha: altitud, si la has conquistado y rutas para subirla. Una cima cuenta cuando pasas a menos de 1 km.')}</p></div>
                {conqueredPeaks.length > 0 ? (
                    <div className="tu-ach-grid">
                        {conqueredPeaks.map((p) => <div key={peakId(p)} className="tu-ach on">
                            <span className="tu-ach-ico" aria-hidden="true">⛰️</span>
                            <b>{p[0]}</b>
                            <small>{p[3].toLocaleString(dateLocale())} m</small>
                        </div>)}
                    </div>
                ) : <div className="tu-callout"><strong>{t('Aun no tienes cimas')}</strong><p>{t('Tu primera cima aparecera aqui en cuanto pases cerca de una.')}</p></div>}
            </section>
        </> : null}

        {tab === 'ajustes' ? <>
            {!isStandalone && (canInstall || isIOS) ? <section className="tu-group"><h2>{t('Instalar la app')}</h2>
                {canInstall ? <button className="file-button is-compact" data-variant="primary" style={{ alignSelf: 'flex-start' }} onClick={() => { void installApp(); }}>{t('Instalar TerraUnlock en este dispositivo')}</button> : null}
                {isIOS ? <small className="tu-dim">{t('En iPhone o iPad: abre TerraUnlock en Safari, pulsa Compartir y elige Anadir a pantalla de inicio.')}</small> : null}
            </section> : null}
            <section className="tu-group"><h2>{t('Perfil')}</h2>
                <div className="tu-setrow">
                    {avatar ? <img className="tu-avatar tu-avatar-img" src={avatar} alt="Tu foto de perfil" /> : <div className="tu-avatar">{(prefs.nombre.trim()[0] || '?').toUpperCase()}</div>}
                    <div className="l" style={{ flex: 1 }}>
                        <b>{prefs.nombre.trim() || t('Sin nombre')}</b>
                        <small>{t('Sin cuenta: tu progreso vive en este dispositivo. El login, los rankings y los piques llegan en la fase 2.')}</small>
                    </div>
                </div>
                <div className="tu-setrow">
                    <div className="l" style={{ flex: 1 }}>
                        <b>{t('Foto de perfil')}</b>
                        <small>{t('Sale en el saludo y en tu tarjeta de compartir. Se recorta a cuadrado y se guarda en este dispositivo.')}</small>
                    </div>
                    <div className="tu-controls">
                        <label className="file-button is-compact" data-variant="primary">{t('Subir foto')}
                            <input type="file" accept="image/*" aria-label={t('Subir foto de perfil')} style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }} onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) processAvatar(f); e.currentTarget.value = ''; }} />
                        </label>
                        {avatar ? <button className="file-button is-compact" data-variant="secondary" onClick={() => setAvatar('')}>{t('Quitar')}</button> : null}
                    </div>
                </div>
                <div className="tu-setrow">
                    <div className="l" style={{ flex: 1 }}>
                        <b>{t('Nombre visible')}</b>
                        <small>{t('Asi te veran tus amigos cuando lleguen los rankings.')}</small>
                    </div>
                    <input className="tu-input" type="text" maxLength={24} placeholder={t('Tu nombre')} value={prefs.nombre} onChange={(e) => setPrefs({ nombre: e.target.value })} />
                </div>
                <div className="tu-setrow">
                    <div className="l" style={{ flex: 1 }}>
                        <b>{t('Cuenta')}</b>
                        <small>{t('Necesaria para sincronizar entre dispositivos y rankings.')}</small>
                    </div>
                    <button className="file-button is-compact" data-variant="secondary" disabled style={{ opacity: 0.5, cursor: 'default' }}>{t('Crear cuenta (proximamente)')}</button>
                </div>
            </section>

            <section className="tu-group"><h2>{t('Apariencia')}</h2>
                <div className="tu-setrow">
                    <div className="l" style={{ flex: 1 }}>
                        <b>{t('Tema')}</b>
                        <small>{t('El aspecto de la interfaz. El mapa siempre usa imagen de satelite.')}</small>
                    </div>
                    <div className="tu-controls" style={{ margin: 0 }}>
                        <button className="file-button is-compact" data-variant={(prefs.theme || 'dark') === 'dark' ? 'primary' : 'secondary'} onClick={() => setPrefs({ theme: 'dark' })}>{t('Oscuro')}</button>
                        <button className="file-button is-compact" data-variant={prefs.theme === 'light' ? 'primary' : 'secondary'} onClick={() => setPrefs({ theme: 'light' })}>{t('Claro')}</button>
                    </div>
                </div>
            </section>

            <section className="tu-group"><h2>{t('Mapa')}</h2>
                <div className="tu-setrow">
                    <div className="l" style={{ flex: 1 }}>
                        <b>{t('Oscuridad de la niebla')}</b>
                        <small>{t('Mas baja = se ve mas el terreno sin descubrir.')}</small>
                    </div>
                    <input type="range" min={0.4} max={0.9} step={0.02} value={prefs.fog} onChange={(e) => setPrefs({ fog: parseFloat(e.target.value) })} style={{ width: 130 }} />
                </div>
                <div className="tu-setrow">
                    <div className="l" style={{ flex: 1 }}>
                        <b>{t('Nombres de cimas')}</b>
                        <small>{t('Etiquetas con nombre y altitud al acercar el zoom.')}</small>
                    </div>
                    <input type="checkbox" className="tu-check" checked={prefs.peakLabels} onChange={(e) => setPrefs({ peakLabels: e.target.checked })} />
                </div>
                <div className="tu-setrow">
                    <div className="l" style={{ flex: 1 }}>
                        <b>{t('Bienvenida')}</b>
                        <small>{t('Vuelve a mostrar la pantalla de inicio al abrir la app.')}</small>
                    </div>
                    <button className="file-button is-compact" data-variant="secondary" onClick={() => { setWStep(0); setPrefs({ welcomed: false }); }}>{t('Mostrar de nuevo')}</button>
                </div>
            </section>

            <section className="tu-group"><h2>{t('Unidades')}</h2>
                <div className="tu-setrow">
                    <div className="l" style={{ flex: 1 }}>
                        <b>{t('Distancias y superficie')}</b>
                    </div>
                    <div className="tu-controls" style={{ margin: 0 }}>
                        <button className="file-button is-compact" data-variant={imp ? 'secondary' : 'primary'} onClick={() => setPrefs({ units: 'metric' })}>km</button>
                        <button className="file-button is-compact" data-variant={imp ? 'primary' : 'secondary'} onClick={() => setPrefs({ units: 'imperial' })}>mi</button>
                    </div>
                </div>
            </section>

            <section className="tu-group"><h2>{t('Objetivo de distancia')}</h2>
                <div className="tu-setrow">
                    <div className="l" style={{ flex: 1 }}>
                        <b>{t('Kilometros por semana')}</b>
                        <small>{t('Te aviso cuando la alcances. Se reinicia cada lunes.')}</small>
                    </div>
                    <div className="tu-controls" style={{ margin: 0 }}>
                        {[0, 10, 25, 50, 100].map((n) => <button key={n} className="file-button is-compact" data-variant={(prefs.weekKm || 0) === n ? 'primary' : 'secondary'} onClick={() => setPrefs({ weekKm: n })}>{n === 0 ? t('No') : n}</button>)}
                    </div>
                </div>
            </section>

            <section className="tu-group"><h2>{t('Idioma')}</h2>
                <div className="tu-setrow">
                    <div className="l" style={{ flex: 1 }}>
                        <b>{t('Idioma')}</b>
                        <small>{t('El idioma de la interfaz. Por defecto se usa el del navegador.')}</small>
                    </div>
                    <div className="tu-controls" style={{ margin: 0 }}>
                        {LANGS.map((l) => <button key={l.id} className="file-button is-compact" data-variant={(prefs.lang || detectLang()) === l.id ? 'primary' : 'secondary'} onClick={() => setPrefs({ lang: l.id })}>{l.label}</button>)}
                    </div>
                </div>
            </section>

            <section className="tu-group"><h2>Strava</h2>
                <div className="tu-setrow">
                    <div className="l" style={{ flex: 1 }}>
                        <b>{strava ? t('Strava conectado{who}', { who: strava.athlete && strava.athlete.firstname ? ' - ' + strava.athlete.firstname : '' }) : t('Conecta tu Strava')}</b>
                        <small>{strava ? t('Trae tus actividades con GPS directamente desde tu cuenta.') : t('Autoriza una vez y trae tus actividades con GPS, sin exportar archivos.')}</small>
                        {strava ? <small className="tu-dim" style={{ display: 'block', marginTop: 6 }}>{t('{n} actividades importadas', { n: strava.importedIds.length })}{strava.lastSync ? ' · ' + t('Ultima sync {d}', { d: new Date(strava.lastSync).toLocaleDateString(dateLocale()) }) : ''}</small> : null}
                        {!strava ? <small className="tu-dim" style={{ display: 'block', marginTop: 6 }}>{t('Si Strava te da Error 403 de limite de deportistas, el cupo de conexion esta lleno y ya lo estamos ampliando. Mientras tanto, importa tus rutas con GPX, FIT o el ZIP de exportacion de Strava desde la seccion Importar rutas.')}</small> : null}
                    </div>
                    <div className="tu-controls" style={{ margin: 0 }}>
                        {!strava ? (
                            <button className="file-button is-compact" data-variant="primary" disabled={stravaBusy} onClick={() => { setStravaBusy(true); beginStravaConnect().catch(() => { setStravaBusy(false); setToast(t('No se pudo conectar con Strava')); }); }}>{stravaBusy ? t('Conectando...') : t('Conectar Strava')}</button>
                        ) : (<>
                            <button className="file-button is-compact" data-variant="primary" disabled={stravaBusy} onClick={() => void importFromStrava()}>{stravaBusy ? t('Importando...') : t('Importar de Strava')}</button>
                            <button className="file-button is-compact" data-variant="secondary" onClick={() => { saveStrava(null); setStrava(null); setToast(t('Strava desconectado')); }}>{t('Desconectar')}</button>
                        </>)}
                    </div>
                </div>
            </section>

            <section className="tu-group"><h2>{t('Datos')}</h2>
                <div className="tu-io">
                    <textarea className="tu-textarea" value={ioText} onChange={(e) => setIoText(e.target.value)} placeholder={t('Aqui aparece tu progreso para exportarlo; pega uno anterior para importarlo.')} rows={3} />
                    <div className="tu-controls">
                        <button className="file-button is-compact" data-variant="secondary" onClick={() => setIoText(JSON.stringify({ v: 2, progress: progressRef.current, achievements: achUnlocked, streak, weekStreak, adventures, profile: { nombre: prefs.nombre, avatar }, prefs: { fog: prefs.fog, peakLabels: prefs.peakLabels, units: prefs.units, lang: prefs.lang, theme: prefs.theme, weekKm: prefs.weekKm } }))}>{t('Exportar')}</button>
                        <button className="file-button is-compact" data-variant="secondary" onClick={() => {
                            try {
                                const data = JSON.parse(ioText);
                                if (data && Array.isArray(data.cells)) {
                                    const next = { ...EMPTY, ...data }; setProgress(next); saveProgress(next); setToast(t('Progreso importado'));
                                } else if (data && data.v >= 2 && data.progress && Array.isArray(data.progress.cells)) {
                                    const next = { ...EMPTY, ...data.progress }; setProgress(next); saveProgress(next);
                                    if (data.achievements && typeof data.achievements === 'object') { setAchUnlocked(data.achievements); saveAch(data.achievements); }
                                    if (data.streak && typeof data.streak.count === 'number') { setStreak(data.streak); saveJson(STREAK_KEY, data.streak); }
                                    if (Array.isArray(data.adventures)) { setAdventures(data.adventures); saveJson(ADVS_KEY, data.adventures); }
                    if (data.weekStreak && typeof data.weekStreak.count === 'number') { setWeekStreak(data.weekStreak); saveJson(WSTREAK_KEY, data.weekStreak); }
                                    if (data.prefs && typeof data.prefs === 'object') {
                                        const sp = data.prefs as Record<string, unknown>; const patch: Partial<Prefs> = {};
                                        if (typeof sp.fog === 'number') patch.fog = sp.fog as number;
                                        if (typeof sp.peakLabels === 'boolean') patch.peakLabels = sp.peakLabels as boolean;
                                        if (sp.units === 'metric' || sp.units === 'imperial') patch.units = sp.units;
                                        if (sp.lang === 'es' || sp.lang === 'en') patch.lang = sp.lang;
                                        if (sp.theme === 'dark' || sp.theme === 'light') patch.theme = sp.theme;
                                        if (typeof sp.weekKm === 'number') patch.weekKm = sp.weekKm as number;
                                        if (Object.keys(patch).length) setPrefs(patch);
                                    }
                                    if (data.profile && typeof data.profile === 'object') {
                                        if (typeof data.profile.nombre === 'string') setPrefs({ nombre: data.profile.nombre });
                                        if (typeof data.profile.avatar === 'string') setAvatar(data.profile.avatar);
                                    }
                                    setToast(t('Copia completa importada'));
                                } else setToast(t('Formato no valido'));
                            } catch { setToast(t('Formato no valido')); }
                        }}>{t('Importar')}</button>
                        <label className="file-button is-compact" data-variant="secondary" style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                            {batchBusy ? t('Leyendo...') : t('Importar rutas')}
                            <input type="file" multiple accept=".gpx,.fit,.zip,.gz,application/gpx+xml" aria-label={t('Importar rutas')} style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }} onChange={(e) => { const input = e.currentTarget; void onImportFiles(input.files).finally(() => { input.value = ''; }); }} />
                        </label>
                        <button className="file-button is-compact" data-variant="secondary" onClick={() => {
                            if (!confirmReset) { setConfirmReset(true); return; }
                            setConfirmReset(false); setProgress({ ...EMPTY }); saveProgress({ ...EMPTY }); setToast(t('Progreso reiniciado'));
                        }}>{confirmReset ? t('Seguro? Toca otra vez') : t('Reiniciar')}</button>
                    </div>
                </div>
                <p className="tu-more">{t('Importar rutas acepta GPX, FIT, .gz sueltos y el ZIP completo de exportacion de Strava o Garmin Connect.')}</p>
            </section>

            <footer className="tu-closing">TerraUnlock v{APP_VERSION}{t(' - tu progreso se guarda en este dispositivo.')}</footer>
        </> : null}

        {banners.length ? (
            <div className="tu-territory" role="status">
                <div className="tu-terr-ico">⚑</div>
                <div className="tu-terr-body">
                    <strong>{banners[0].title}</strong>
                    <small>{banners[0].sub}{banners.length > 1 ? t(' - +{n} mas a continuacion', { n: banners.length - 1 }).replace(' - ', ' · ') : ''}</small>
                </div>
                <button className="file-button is-compact" data-variant="primary" onClick={() => shareCard()}>{t('Compartir')}</button>
                <button className="tu-terr-x" aria-label={t('Cerrar aviso')} onClick={() => setBanners((b) => b.slice(1))}>×</button>
            </div>
        ) : null}

        {mrecap ? (
            <div className="tu-celebration" role="dialog" aria-modal="true" aria-label={t('Resumen de {mes}', { mes: mrecap.month })}>
                <div className="tu-celeb-card">
                    <div className="tu-celeb-ico">☾</div>
                    <h2>{t('Resumen de {mes}', { mes: mrecap.month })}</h2>
                    <strong>{mrecap.advs === 1 ? t('{km} en 1 aventura', { km: fmtDist(mrecap.km) }) : t('{km} en {n} aventuras', { km: fmtDist(mrecap.km), n: mrecap.advs })}</strong>
                    <p>{mrecap.terr > 0 ? t('{n} territorios nuevos', { n: mrecap.terr }) : t('Sin territorios nuevos')}{mrecap.peaks > 0 ? t(' - {n} cimas', { n: mrecap.peaks }) : ''}</p>
                    <div className="tu-controls" style={{ justifyContent: 'center' }}>
                        <button className="file-button is-compact" data-variant="primary" onClick={() => shareMonthCard(true)}>{t('Compartir')}</button>
                        <button className="file-button is-compact" data-variant="secondary" onClick={() => setMrecap(null)}>{t('A por este mes')}</button>
                    </div>
                </div>
            </div>
        ) : null}

        {recap ? (
            <div className="tu-celebration" role="dialog" aria-modal="true" aria-label={t('Resumen de tu semana')}>
                <div className="tu-celeb-card">
                    <div className="tu-celeb-ico">☀</div>
                    <h2>{t('Resumen de tu semana')}</h2>
                    <strong>{recap.advs === 1 ? t('{km} en 1 aventura', { km: fmtDist(recap.km) }) : t('{km} en {n} aventuras', { km: fmtDist(recap.km), n: recap.advs })}</strong>
                    <p>{recap.terr > 0 ? t('{n} territorios nuevos', { n: recap.terr }) : t('Sin territorios nuevos')}{recap.peaks > 0 ? t(' - {n} cimas', { n: recap.peaks }) : ''}</p>
                    <div className="tu-controls" style={{ justifyContent: 'center' }}>
                        <button className="file-button is-compact" data-variant="primary" onClick={() => shareWeekCard(true)}>{t('Compartir')}</button>
                        <button className="file-button is-compact" data-variant="secondary" onClick={() => setRecap(null)}>{t('A por esta semana')}</button>
                    </div>
                </div>
            </div>
        ) : null}

        {celebration.length ? (
            <div className="tu-celebration" role="dialog" aria-modal="true" aria-label={celebration.length > 1 ? t('{n} logros desbloqueados', { n: celebration.length }) : t('Logro desbloqueado')}>
                <div className="tu-celeb-card">
                    <div className="tu-celeb-ico">★</div>
                    <h2>{celebration.length > 1 ? t('{n} logros desbloqueados', { n: celebration.length }) : t('Logro desbloqueado')}</h2>
                    {celebration.length === 1 ? <>
                        <strong>{t(celebration[0].title)}</strong>
                        <p>{t(celebration[0].hint)}</p>
                    </> : <ul className="tu-celeb-list">
                        {celebration.slice(0, 6).map((a) => <li key={a.id}><strong>{t(a.title)}</strong><small>{t(a.hint)}</small></li>)}
                        {celebration.length > 6 ? <li><small>{t('y {n} mas', { n: celebration.length - 6 })}</small></li> : null}
                    </ul>}
                    <div className="tu-controls" style={{ justifyContent: 'center' }}>
                        <button className="file-button is-compact" data-variant="primary" onClick={() => { if (celebration.length === 1) void shareAchievementCard(celebration[0]); else void shareCard(); }}>{t('Compartir')}</button>
                        <button className="file-button is-compact" data-variant="secondary" onClick={() => setCelebration([])}>{t('Seguir explorando')}</button>
                    </div>
                </div>
            </div>
        ) : null}

        {importBatch ? (
            <div className="tu-celebration" role="dialog" aria-modal="true" aria-label={t('Importar rutas')}>
                <div className="tu-celeb-card">
                    <div className="tu-celeb-ico">⇪</div>
                    <h2>{t('Importar rutas')}</h2>
                    <strong>{importBatch.tracksOk > 1 ? t('{n} actividades listas', { n: importBatch.tracksOk }) : importBatch.scans[0]?.name}</strong>
                    <p>{importBatch.tracksOk > 1 ? t('{km} km en total', { km: dec(importBatch.totalKm) }) : importBatch.scans[0] ? t('{n} puntos, {km} km', { n: importBatch.scans[0].pts.length, km: dec(importBatch.scans[0].km) }) : ''}. {t('Va a revelar la niebla de todo el recorrido y desbloqueara: {lista}.', { lista: (() => {
                        const p0 = progress;
                        const names = [...new Set([...importBatch.work.countries.slice(p0.countries.length), ...importBatch.work.ccaa.slice(p0.ccaa.length), ...importBatch.work.prov.slice(p0.prov.length)])];
                        const pk = importBatch.work.peaks.length - p0.peaks.length;
                        return names.length + pk ? names.join(', ') + (pk ? t(' y {n} cimas', { n: pk }) : '') : t('nada nuevo (zona ya desbloqueada)');
                    })() })}</p>
                    {importBatch.tracksOk > 1 ? <small>{importBatch.scans.slice(0, 6).map((sc) => sc.name + ' · ' + fmtDist(sc.km)).join(' · ')}{importBatch.tracksOk > 6 ? ' …' : ''}</small> : null}
                    {importBatch.dups ? <small>{t('{n} ya las tenias importadas: las he saltado', { n: importBatch.dups })}</small> : null}
                    {importBatch.scans.length <= 20 ? <small>{t('Cada actividad se guardara como aventura en tu historial.')}</small> : null}
                    {importBatch.failed ? <small>{t('({n} archivos no se pudieron leer)', { n: importBatch.failed })}</small> : null}
                    <div className="tu-controls" style={{ justifyContent: 'center', marginTop: 10 }}>
                        <button className="file-button is-compact" data-variant="primary" onClick={applyBatch}>{importBatch.tracksOk > 1 ? t('Aplicar lote') : t('Aplicar ruta')}</button>
                        <button className="file-button is-compact" data-variant="secondary" onClick={() => setImportBatch(null)}>{t('Cancelar')}</button>
                    </div>
                </div>
            </div>
        ) : null}

        {advSummary ? (
            <div className="tu-celebration" role="dialog" aria-modal="true" aria-label={t('Aventura terminada')}>
                <div className="tu-celeb-card">
                    <div className="tu-celeb-ico">⚑</div>
                    <h2>{t('Aventura terminada')}</h2>
                    <strong>{fmtDist(advSummary.km)}</strong>
                    <p>{t('{n} puntos GPS', { n: advSummary.points })}{[...advSummary.countries, ...advSummary.ccaa, ...advSummary.prov].length ? t(' - Desbloqueos: ').replace(' - ', ' · ') + [...advSummary.countries, ...advSummary.ccaa, ...advSummary.prov].join(', ') : ''}{advSummary.peaks.length ? ' · ' + t('{n} cimas', { n: advSummary.peaks.length }) : ''}{![...advSummary.countries, ...advSummary.ccaa, ...advSummary.prov, ...advSummary.peaks].length ? t(' - Sin desbloqueos nuevos esta vez').replace(' - ', ' · ') : ''}</p>
                    {(() => { const ps = paceStats(advSummary, imp); return ps ? <p style={{ color: '#2dc8aa', fontWeight: 600 }}>{t('Ritmo medio {pace}', { pace: fmtPace(ps.avg, imp) })}{ps.best ? t(imp ? ' - Mejor milla {pace}' : ' - Mejor km {pace}', { pace: fmtPace(ps.best, imp) }) : ''}</p> : null; })()}
                    {(() => { const mv = movingStats(advSummary); return mv ? <p style={{ color: '#2dc8aa', fontWeight: 600 }}>{t('En movimiento {dur}', { dur: fmtDur(mv.moveMs) })}{mv.pauseMs >= 60000 ? t(' - Pausas {dur}', { dur: fmtDur(mv.pauseMs) }) : ''}</p> : null; })()}
                    <ElevChart adv={advSummary} onProfile={saveProfile} />
                    <PaceChart adv={advSummary} imp={imp} />
                    <div className="tu-controls" style={{ justifyContent: 'center' }}>
                        {advSummary.track && advSummary.track.length >= 2 ? <button className="file-button is-compact" data-variant="secondary" onClick={() => { setAdvSummary(null); showAdvOnMap(advSummary); }}>{t('Ver en el mapa')}</button> : null}
                        <button className="file-button is-compact" data-variant="primary" onClick={() => shareAdventureCard(advSummary)}>{t('Compartir aventura')}</button>
                        <button className="file-button is-compact" data-variant="secondary" onClick={() => exportGpx(advSummary)}>{t('Exportar GPX')}</button>
                        <button className="file-button is-compact" data-variant="secondary" onClick={() => setAdvSummary(null)}>{t('Cerrar')}</button>
                    </div>
                </div>
            </div>
        ) : null}

        {toast ? <div className="tu-toast">{toast}</div> : null}
        {undoAdv ? <div className="tu-toast" style={{ bottom: 140, pointerEvents: 'auto' }}><button className="file-button is-compact" data-variant="primary" onClick={undoDeleteAdv}>{t('Deshacer')}</button></div> : null}
        {swUpdate ? <div className="tu-updbar">
            <span>{t('Nueva version lista')}</span>
            <button className="file-button is-compact" data-variant="primary" onClick={() => window.location.reload()}>{t('Actualizar')}</button>
        </div> : null}

        <nav className="tu-nav">
            <div className="tu-brand">TerraUnlock</div>
            {([
                ['inicio', '⌂', t('Inicio')],
                ['mapa', '◉', t('Mapa')],
                ['progreso', '◆', t('Progreso')],
                ['cimas', '▲', t('Cimas')],
                ['ajustes', '⚙', t('Ajustes')],
            ] as const).map(([id, g, label]) => (
                <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}><span className="g">{g}</span>{label}</button>
            ))}
        </nav>

        {!prefs.welcomed ? (
            <div className="tu-welcome">
                {wStep === 0 ? <>
                    <img src="./icons/icon-192.png" alt="TerraUnlock" />
                    <h1>TerraUnlock</h1>
                    <p className="tu-intro" style={{ maxWidth: 340 }}>{t('El mundo empieza cubierto de niebla y se revela donde pisas. Conquista paises, comunidades, provincias y cimas con tu GPS real.')}</p>
                    <button className="file-button" data-variant="primary" onClick={() => setWStep(1)}>{t('Empezar')}</button>
                </> : null}
                {wStep === 1 ? <>
                    <div className="tu-wico">🌫️</div>
                    <h1 className="tu-wtitle">{t('Como se juega')}</h1>
                    <ul>
                        <li>{t('Camina, corre o pedalea: la niebla se abre a tu paso.')}</li>
                        <li>{t('Desbloquea paises, comunidades, provincias y mas de 57.000 cimas.')}</li>
                        <li>{t('Registra aventuras, cumple el objetivo semanal y comparte tarjetas de tu progreso.')}</li>
                    </ul>
                    <button className="file-button" data-variant="primary" onClick={() => setWStep(2)}>{t('Siguiente')}</button>
                </> : null}
                {wStep === 2 ? <>
                    <div className="tu-wico">⇪</div>
                    <h1 className="tu-wtitle">{t('Tu historial cuenta')}</h1>
                    <p className="tu-intro" style={{ maxWidth: 340 }}>{t('Usas Strava o Garmin? Importa tus rutas (GPX, FIT o el ZIP completo de exportacion) y conquista de golpe todo lo que ya has pisado.')}</p>
                    <p className="tu-intro" style={{ maxWidth: 340, fontSize: 13, opacity: 0.7 }}>{t('Lo encontraras en Ajustes, Importar rutas.')}</p>
                    <button className="file-button" data-variant="primary" onClick={() => setWStep(3)}>{t('Siguiente')}</button>
                </> : null}
                {wStep === 3 ? <>
                    <div className="tu-wico">📍</div>
                    <h1 className="tu-wtitle">{t('Tu ubicacion, solo en tu movil')}</h1>
                    <p className="tu-intro" style={{ maxWidth: 340 }}>{t('Para revelar la niebla en directo la app necesita tu GPS. Tu posicion y tu progreso se guardan unicamente en este dispositivo.')}</p>
                    <div className="tu-controls" style={{ justifyContent: 'center' }}>
                        <button className="file-button" data-variant="primary" onClick={welcomeGps}>{t('Activar GPS y empezar')}</button>
                        <button className="file-button" data-variant="secondary" onClick={() => setPrefs({ welcomed: true })}>{t('Ahora no')}</button>
                    </div>
                </> : null}
                <div className="tu-wdots">{[0, 1, 2, 3].map((i) => <span key={i} className={i === wStep ? 'on' : ''} />)}</div>
            </div>
        ) : null}
    </div>}
