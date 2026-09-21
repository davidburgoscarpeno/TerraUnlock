import React, { useEffect, useMemo, useRef, useState } from 'react';
import './style.css';
import { COUNTRIES } from './data/countries';
import type { Region } from './data/countries';
import { CCAA } from './data/ccaa';
import { PROV } from './data/prov';
import { PEAKS_ES } from './data/peaks_es';
import type { Peak } from './data/peaks_es';
import { PEAKS_WORLD } from './data/peaks_world';

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
interface Adventure { start: string; end: string; km: number; points: number; countries: string[]; ccaa: string[]; prov: string[]; peaks: string[]; }
interface ActiveAdventure { start: string; km: number; points: number; countries0: string[]; ccaa0: string[]; prov0: string[]; peaks0: string[]; }
interface Streak { last: string; count: number; }
const ADV_ACTIVE_KEY = 'terraunlock.adventure.active.v1';
const ADVS_KEY = 'terraunlock.adventures.v1';
const STREAK_KEY = 'terraunlock.streak.v1';
function loadJson<T>(key: string): T | null { try { const raw = localStorage.getItem(key); if (raw) return JSON.parse(raw) as T; } catch { /* sin datos */ } return null; }
function saveJson(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* sin espacio */ } }
function dayKey(d: Date) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

// v1.2: logros. Definicion declarativa; el desbloqueo se evalua sobre el progreso actual.
interface Achievement { id: string; title: string; hint: string; test: (p: Progress, s: { count: number }) => boolean; }
const ACHIEVEMENTS: Achievement[] = [
    { id: 'first-zone', title: 'Primeros pasos', hint: 'Revela tu primera zona del mapa', test: (p) => p.cells.length >= 1 },
    { id: 'km-10', title: 'Barrio propio', hint: 'Revela 10 km2 de superficie', test: (p) => p.cells.length * 1.1 >= 10 },
    { id: 'km-100', title: 'Cartografo local', hint: 'Revela 100 km2 de superficie', test: (p) => p.cells.length * 1.1 >= 100 },
    { id: 'km-1000', title: 'Cartografo nacional', hint: 'Revela 1.000 km2 de superficie', test: (p) => p.cells.length * 1.1 >= 1000 },
    { id: 'country-1', title: 'Primera bandera', hint: 'Pisa tu primer pais', test: (p) => p.countries.length >= 1 },
    { id: 'country-5', title: 'Pasaporte sellado', hint: 'Pisa 5 paises distintos', test: (p) => p.countries.length >= 5 },
    { id: 'country-10', title: 'Trotamundos', hint: 'Pisa 10 paises distintos', test: (p) => p.countries.length >= 10 },
    { id: 'country-25', title: 'Sin fronteras', hint: 'Pisa 25 paises distintos', test: (p) => p.countries.length >= 25 },
    { id: 'ccaa-1', title: 'Comunidad propia', hint: 'Desbloquea tu primera comunidad', test: (p) => p.ccaa.length >= 1 },
    { id: 'ccaa-19', title: 'Espana completa', hint: 'Desbloquea las 19 comunidades', test: (p) => p.ccaa.length >= 19 },
    { id: 'prov-1', title: 'Provincia propia', hint: 'Desbloquea tu primera provincia', test: (p) => p.prov.length >= 1 },
    { id: 'peak-1', title: 'Primera cima', hint: 'Conquista tu primera cima', test: (p) => p.peaks.length >= 1 },
    { id: 'peak-10', title: 'Coleccionista de cimas', hint: 'Conquista 10 cimas', test: (p) => p.peaks.length >= 10 },
    { id: 'peak-25', title: 'Montanero de verdad', hint: 'Conquista 25 cimas', test: (p) => p.peaks.length >= 25 },
    { id: 'points-100', title: 'En movimiento', hint: 'Registra 100 puntos GPS', test: (p) => p.points.length >= 100 },
    { id: 'points-1000', title: 'Imparable', hint: 'Registra 1.000 puntos GPS', test: (p) => p.points.length >= 1000 },
    { id: 'streak-3', title: 'En racha', hint: 'Revela territorio 3 dias seguidos', test: (p, st) => st.count >= 3 },
    { id: 'streak-7', title: 'Semana de conquista', hint: 'Revela territorio 7 dias seguidos', test: (p, st) => st.count >= 7 },
];
const ACH_KEY = 'terraunlock.achievements.v1';
function loadAch(): Record<string, string> | null {
    try { const raw = localStorage.getItem(ACH_KEY); if (raw) return JSON.parse(raw); } catch { /* sin logros */ }
    return null;
}
function saveAch(a: Record<string, string>) { try { localStorage.setItem(ACH_KEY, JSON.stringify(a)); } catch { /* sin espacio */ } }

// Preferencias de la app (ajustes): perfil visible, mapa, unidades, bienvenida
interface Prefs { nombre: string; fog: number; peakLabels: boolean; units: 'metric' | 'imperial'; welcomed: boolean; }
const PREFS_KEY = 'terraunlock.prefs.v1';
const AVATAR_KEY = 'terraunlock.avatar.v1';
function loadPrefs(): Prefs {
    const base: Prefs = { nombre: '', fog: 0.68, peakLabels: true, units: 'metric', welcomed: false };
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
};

function parseGpx(text: string): { name: string; pts: [number, number][] } {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('XML no valido');
    const name = doc.querySelector('trk > name')?.textContent || doc.querySelector('metadata > name')?.textContent || 'Ruta GPX';
    const pts: [number, number][] = [];
    doc.querySelectorAll('trkpt, rtept, wpt').forEach((el) => {
        const lat = parseFloat(el.getAttribute('lat') || ''), lon = parseFloat(el.getAttribute('lon') || '');
        if (isFinite(lat) && isFinite(lon)) pts.push([lat, lon]);
    });
    if (pts.length < 2) throw new Error('Sin puntos de track');
    return { name, pts };
}

// Escanea un track contra el progreso actual: que celdas revela y que desbloquea (sin mutar nada)
function scanTrack(name: string, raw: [number, number][], p: Progress, peakGrid: Map<string, Peak[]>): TrackScan {
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
    return { name, pts, km, countries: nCountries, ccaa: nCcaa, prov: nProv, peaks: nPeaks, cells: [...cells] };
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
    const [tab, setTab] = useState<'mapa' | 'progreso' | 'cimas' | 'ajustes'>('mapa');
    const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
    const prefsRef = useRef(prefs); prefsRef.current = prefs;
    const setPrefs = (patch: Partial<Prefs>) => {
        const next = { ...prefsRef.current, ...patch };
        setPrefsState(next);
        try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* sin espacio */ }
    };
    const imp = prefs.units === 'imperial';
    const fmtDist = (km: number) => imp ? (km * 0.621371).toFixed(1).replace('.', ',') + ' mi' : km.toFixed(1).replace('.', ',') + ' km';
    const fmtAreaShort = (k2: number) => (imp ? (k2 * 0.386102).toFixed(0) + ' mi2' : k2.toFixed(0) + ' km2');
    const [gpsMsg, setGpsMsg] = useState('');
    const [lastPos, setLastPos] = useState<[number, number] | null>(null);
    const [toast, setToast] = useState('');
    const [ioText, setIoText] = useState('');
    const [confirmReset, setConfirmReset] = useState(false);
    type ImportBatch = { scans: TrackScan[]; files: number; tracksOk: number; failed: number; totalKm: number; work: Progress };
    const [importBatch, setImportBatch] = useState<ImportBatch | null>(null);
    const [batchBusy, setBatchBusy] = useState(false);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const wrapRef = useRef<HTMLDivElement>(null);
    const fogRef = useRef<HTMLCanvasElement | null>(null);
    const wakeRef = useRef<{ release?: () => Promise<void> } | null>(null);
    const tileCache = useRef(new Map<string, HTMLImageElement | 'loading' | 'error'>());
    const tileRaf = useRef(0);
    const [tileTick, setTileTick] = useState(0);
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

    const addPoint = (lat: number, lon: number) => {
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
        if (isNewPoint) next.points = [...pts.slice(-19999), [lat, lon]];
        const terr: TerrBanner[] = [];
        if (isNewPoint) {
            const rg = regionsCached(lon, lat);
            if (rg.c && !next.countries.includes(rg.c)) { next.countries = [...next.countries, rg.c]; terr.push({ title: 'Pais nuevo: ' + rg.c, sub: 'Ya llevas ' + next.countries.length + ' de 177' }); }
            if (rg.a && !next.ccaa.includes(rg.a)) { next.ccaa = [...next.ccaa, rg.a]; terr.push({ title: 'Comunidad nueva: ' + rg.a, sub: 'Ya llevas ' + next.ccaa.length + ' de 19' }); }
            if (rg.pv && !next.prov.includes(rg.pv)) { next.prov = [...next.prov, rg.pv]; terr.push({ title: 'Provincia nueva: ' + rg.pv, sub: 'Ya llevas ' + next.prov.length + ' de 52' }); }
            const pkSet = new Set(next.peaks);
            const gi = Math.floor(lat * 2), gj = Math.floor(lon * 2);
            for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
                const arr = peakGrid.get((gi + di) + ',' + (gj + dj)); if (!arr) continue;
                for (const pk of arr) {
                    const id = peakId(pk);
                    if (!pkSet.has(id) && distM([pk[1], pk[2]], [lat, lon]) <= PEAK_M) {
                        next.peaks = [...next.peaks, id]; pkSet.add(id);
                        news.push('Cima conquistada: ' + pk[0] + ' (' + pk[3] + ' m)');
                    }
                }
            }
        }
        if (news.length) setToast(news[news.length - 1] + (news.length > 1 ? ' (+' + (news.length - 1) + ' mas)' : ''));
        if (terr.length) { setBanners((b) => [...b, ...terr]); try { navigator.vibrate?.(80); } catch { /* sin vibracion */ } }
        if (isNewCell || isNewPoint || news.length) { setProgress(next); saveProgress(next); }
        setLastPos([lat, lon]);
        const a = advRef.current;
        if (a && isNewPoint) {
            const inc = last ? distM(last, [lat, lon]) / 1000 : 0;
            const na = { ...a, km: a.km + inc, points: a.points + 1 };
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
            const tracks: { name: string; pts: [number, number][] }[] = [];
            let failed = 0;
            const pushGpx = (text: string, fallback: string) => {
                try { const g = parseGpx(text); tracks.push({ name: g.name === 'Ruta GPX' ? fallback : g.name, pts: g.pts }); }
                catch { failed++; }
            };
            const pushFit = async (buf: ArrayBuffer, fallback: string) => {
                try {
                    const { default: FitParser } = await import('fit-file-parser');
                    const parser = new FitParser({ mode: 'list' });
                    const data = await parser.parseAsync(buf) as { records?: { position_lat?: number; position_long?: number }[] };
                    const pts: [number, number][] = [];
                    for (const r of data.records || []) {
                        if (typeof r.position_lat === 'number' && typeof r.position_long === 'number') pts.push([r.position_lat, r.position_long]);
                    }
                    if (pts.length < 2) throw new Error('sin puntos');
                    tracks.push({ name: fallback, pts });
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
            if (!tracks.length) { setToast(failed ? 'No se pudo leer ninguna actividad (' + failed + ' con error)' : 'No se encontraron actividades GPX/FIT'); return; }
            // Escanear en lote contra una copia del progreso que se actualiza entre tracks
            const p0 = progressRef.current;
            const work: Progress = { cells: [...p0.cells], points: [...p0.points], countries: [...p0.countries], ccaa: [...p0.ccaa], prov: [...p0.prov], peaks: [...p0.peaks] };
            const scans: TrackScan[] = [];
            let totalKm = 0;
            let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
            for (const t of tracks) {
                const sc = scanTrack(t.name, t.pts, work, peakGrid);
                scans.push(sc); totalKm += sc.km;
                work.cells = sc.cells;
                work.countries = [...work.countries, ...sc.countries];
                work.ccaa = [...work.ccaa, ...sc.ccaa];
                work.prov = [...work.prov, ...sc.prov];
                work.peaks = [...work.peaks, ...sc.peaks];
                for (const q of sc.pts) { if (q[0] < minLat) minLat = q[0]; if (q[0] > maxLat) maxLat = q[0]; if (q[1] < minLon) minLon = q[1]; if (q[1] > maxLon) maxLon = q[1]; }
            }
            const w = wrapRef.current?.clientWidth || 800, h = wrapRef.current?.clientHeight || 500;
            const spanLon = Math.max(0.001, maxLon - minLon), spanLat = Math.max(0.001, maxLat - minLat);
            const zx = Math.log2((w * 0.7 * 360) / (256 * spanLon));
            const zy = Math.log2((h * 0.7 * 360) / (256 * spanLat * 1.4));
            setViewPersist({ lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2, z: Math.max(3, Math.min(14, Math.min(zx, zy))) });
            setImportBatch({ scans, files: files.length, tracksOk: tracks.length, failed, totalKm, work });
            setTab('mapa');
        } catch (e) { setToast('Importacion fallida: ' + (e instanceof Error ? e.message : 'error')); }
        finally { setBatchBusy(false); }
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
        const parts: string[] = [];
        if (news.countries.length) parts.push(news.countries.length + ' paises');
        if (news.ccaa.length) parts.push(news.ccaa.length + ' CCAA');
        if (news.prov.length) parts.push(news.prov.length + ' provincias');
        if (news.peaks.length) parts.push(news.peaks.length + ' cimas');
        setToast((b.tracksOk > 1 ? 'Lote aplicado (' + b.tracksOk + ' actividades, ' : 'Ruta aplicada (') + fmtDist(b.totalKm) + '): ' + (parts.length ? '+' + parts.join(', +') : 'zona ya desbloqueada'));
        const tparts: string[] = [];
        if (news.prov.length) tparts.push(news.prov.length + ' provincia' + (news.prov.length > 1 ? 's' : ''));
        if (news.ccaa.length) tparts.push(news.ccaa.length + ' comunidad' + (news.ccaa.length > 1 ? 'es' : ''));
        if (news.countries.length) tparts.push(news.countries.length + ' pais' + (news.countries.length > 1 ? 'es' : ''));
        if (news.peaks.length) tparts.push(news.peaks.length + ' cima' + (news.peaks.length > 1 ? 's' : ''));
        if (tparts.length) { setBanners((bb) => [...bb, { title: 'Territorio nuevo por importacion', sub: '+' + tparts.join(', +') }]); try { navigator.vibrate?.(80); } catch { /* sin vibracion */ } }
    };

    // GPS real
    useEffect(() => {
        if (!gpsOn) return;
        if (!('geolocation' in navigator)) { setGpsMsg('Este navegador no expone GPS dentro de la pagina. Usa el modo prueba.'); setGpsOn(false); return; }
        const id = navigator.geolocation.watchPosition(
            (pos) => { setGpsMsg(''); addPoint(pos.coords.latitude, pos.coords.longitude); },
            (err) => { setGpsMsg('GPS no disponible: ' + err.message + '. Mientras, puedes usar el modo prueba.'); setGpsOn(false); },
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
            ctx.beginPath(); ctx.arc(x, y, 10, 0, 7); ctx.fillStyle = 'rgba(45,200,170,0.25)'; ctx.fill();
            ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fillStyle = '#2dc8aa'; ctx.fill();
            ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.stroke();
        }
    }, [view, progress, lastPos, tileTick, importBatch, allPeaks, selectedPeak, prefs]);

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
    }, []);

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
                (pos) => { addPoint(pos.coords.latitude, pos.coords.longitude); setViewPersist({ lon: pos.coords.longitude, lat: pos.coords.latitude, z: 13 }); },
                () => setToast('No se pudo obtener tu posicion'),
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
    const showPeakOnMap = (p: Peak) => { setSelectedPeak(p); setSelectedRegion(null); setViewPersist({ lon: p[2], lat: p[1], z: 11 }); setTab('mapa'); };
    const locateForNearby = () => {
        if (!('geolocation' in navigator)) { setToast('Tu navegador no soporta geolocalizacion'); return; }
        navigator.geolocation.getCurrentPosition(
            (pos) => { addPoint(pos.coords.latitude, pos.coords.longitude); setLastPos([pos.coords.latitude, pos.coords.longitude]); },
            () => setToast('No se pudo obtener tu posicion'),
            { enableHighAccuracy: true, timeout: 15000 }
        );
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
            if (prefs.nombre.trim()) { g.fillStyle = '#2dc8aa'; g.font = '700 34px -apple-system, Segoe UI, Roboto, sans-serif'; g.fillText('El mundo de ' + prefs.nombre.trim(), 224, 170); }
            g.fillStyle = '#9fb0c0'; g.font = '600 30px -apple-system, Segoe UI, Roboto, sans-serif';
            const st = '~' + fmtAreaShort(progress.cells.length * 1.1) + ' revelados   -   ' + progress.countries.length + '/177 paises   -   ' + progress.ccaa.length + '/19 CCAA   -   ' + progress.peaks.length + ' cimas';
            g.fillText(st, 60, 228);
            g.fillStyle = '#5c7080'; g.font = '600 26px -apple-system, Segoe UI, Roboto, sans-serif';
            g.fillText('Cuantos paises has pisado? davidburgoscarpeno.github.io/TerraUnlock', 60, H - 60);
            const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/png'));
            if (!blob) { setToast('No se pudo generar la tarjeta'); return; }
            const file = new File([blob], 'terraunlock.png', { type: 'image/png' });
            const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean; share?: (d: { files: File[]; title: string }) => Promise<void> };
            if (nav.canShare && nav.share && nav.canShare({ files: [file] })) {
                await nav.share({ files: [file], title: 'TerraUnlock' });
            } else {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'terraunlock.png';
                a.click();
                setToast('Tarjeta descargada');
            }
        } catch (e) {
            if (e instanceof Error && e.name === 'AbortError') return;
            setToast('No se pudo compartir la tarjeta');
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
        catch { setToast('Foto demasiado grande para guardar en este dispositivo'); }
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
            img.onerror = () => setToast('No se pudo leer esa imagen');
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

    // v1.3: modo aventura y racha
    const [adv, setAdv] = useState<ActiveAdventure | null>(() => loadJson<ActiveAdventure>(ADV_ACTIVE_KEY));
    const advRef = useRef(adv);
    useEffect(() => { advRef.current = adv; }, [adv]);
    const [adventures, setAdventures] = useState<Adventure[]>(() => loadJson<Adventure[]>(ADVS_KEY) || []);
    const [advSummary, setAdvSummary] = useState<Adventure | null>(null);
    const [advTick, setAdvTick] = useState(0);
    useEffect(() => { if (!adv) return; const t = setInterval(() => setAdvTick((x) => x + 1), 15000); return () => clearInterval(t); }, [adv]);
    const startAdventure = () => {
        const p = progressRef.current;
        const a: ActiveAdventure = { start: new Date().toISOString(), km: 0, points: 0, countries0: p.countries, ccaa0: p.ccaa, prov0: p.prov, peaks0: p.peaks };
        advRef.current = a; setAdv(a); saveJson(ADV_ACTIVE_KEY, a);
        setToast('Aventura empezada: sal a conquistar');
    };
    const endAdventure = () => {
        const a = advRef.current;
        if (!a) return;
        const p = progressRef.current;
        const done: Adventure = {
            start: a.start, end: new Date().toISOString(), km: a.km, points: a.points,
            countries: p.countries.filter((n) => !a.countries0.includes(n)),
            ccaa: p.ccaa.filter((n) => !a.ccaa0.includes(n)),
            prov: p.prov.filter((n) => !a.prov0.includes(n)),
            peaks: p.peaks.filter((n) => !a.peaks0.includes(n)),
        };
        const list = [done, ...adventures].slice(0, 50);
        setAdventures(list); saveJson(ADVS_KEY, list);
        advRef.current = null; setAdv(null);
        try { localStorage.removeItem(ADV_ACTIVE_KEY); } catch { /* sin espacio */ }
        setAdvSummary(done);
    };
    const advElapsed = adv ? (() => { const m = Math.max(0, Math.floor((Date.now() + advTick * 0 - new Date(adv.start).getTime()) / 60000)); return m >= 60 ? Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min' : m + ' min'; })() : '';

    const km2 = (progress.cells.length * 1.1).toFixed(0);
    const conqueredPeaks = progress.peaks.map((id) => peakById.get(id)).filter((p): p is Peak => !!p);

    return <div className="tu-app">
        {tab === 'mapa' ? <>
            <header className="tu-header">
                <div className="tu-header-row"><h1 className="tu-h1-av">{avatar ? <img className="tu-avatar-sm" src={avatar} alt="" /> : null}{prefs.nombre ? 'Hola, ' + prefs.nombre : 'TerraUnlock'}</h1><span className="tu-fact">{fmtAreaShort(progress.cells.length * 1.1)} revelados</span>{streak.count >= 2 ? <span className="tu-streak">Racha: {streak.count} dias</span> : null}</div>
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
                <span>Paises {progress.countries.length}/{COUNTRIES.length}</span>
                <span>CCAA {progress.ccaa.length}/{CCAA.length}</span>
                <span>Prov {progress.prov.length}/{PROV.length}</span>
                <span>Cimas {progress.peaks.length}</span>
            </div>
            {nearestPeak ? <div className="tu-peaknear">{'▲'} {nearestPeak.p[0]} · {fmtDist(nearestPeak.d / 1000)}</div> : null}
            {scaleBar ? <div className="tu-scalebar"><span>{scaleBar.label}</span><i style={{ width: scaleBar.w }} /></div> : null}
            <div className="tu-attr">Esri, Maxar, Earthstar Geographics</div>
        </div>

        <div className="tu-controls">
            <button className="file-button is-compact" data-variant={gpsOn ? 'primary' : 'secondary'} onClick={() => setGpsOn(!gpsOn)}>{gpsOn ? 'GPS activado' : 'Activar GPS'}</button>
            <button className="file-button is-compact" data-variant="secondary" onClick={centerOnMe}>Centrar en mi</button>
            <button className="file-button is-compact" data-variant={simMode ? 'primary' : 'secondary'} onClick={() => setSimMode(!simMode)}>{simMode ? 'Modo prueba: ON' : 'Modo prueba'}</button>
            <button className="file-button is-compact" data-variant="secondary" onClick={() => zoomAt((wrapRef.current?.clientWidth || 0) / 2, (wrapRef.current?.clientHeight || 0) / 2, 1)}>+</button>
            <button className="file-button is-compact" data-variant="secondary" onClick={() => zoomAt((wrapRef.current?.clientWidth || 0) / 2, (wrapRef.current?.clientHeight || 0) / 2, -1)}>-</button>
            {!adv ? <button className="file-button is-compact" data-variant="primary" onClick={startAdventure}>Empezar aventura</button> : null}
        </div>

        {adv ? <div className="tu-callout tu-advpanel">
            <strong>Aventura en curso</strong>
            <p>{fmtDist(adv.km)} · {advElapsed} · {adv.points} puntos · +{progress.countries.length - adv.countries0.length} paises, +{progress.ccaa.length - adv.ccaa0.length} CCAA, +{progress.prov.length - adv.prov0.length} prov, +{progress.peaks.length - adv.peaks0.length} cimas</p>
            <div className="tu-controls"><button className="file-button is-compact" data-variant="primary" onClick={endAdventure}>Terminar aventura</button></div>
        </div> : null}
        {gpsMsg ? <div className="tu-callout tu-warn"><strong>GPS</strong><p>{gpsMsg}</p></div> : null}
        {simMode ? <div className="tu-callout"><strong>Modo prueba</strong><p>Toca cualquier punto del mapa para simular que has estado ahi: revela niebla y desbloquea igual que el GPS.</p></div> : null}

        {importBatch ? (
            <div className="tu-callout">
                <strong>{importBatch.tracksOk > 1 ? importBatch.tracksOk + ' actividades listas' : importBatch.scans[0]?.name}</strong>
                <p>{importBatch.tracksOk > 1 ? importBatch.totalKm.toFixed(1) + ' km en total' : importBatch.scans[0] ? importBatch.scans[0].pts.length + ' puntos, ' + importBatch.scans[0].km.toFixed(1) + ' km' : ''}. Va a revelar la niebla de todo el recorrido y desbloqueara: {(() => {
                    const p0 = progress;
                    const names = [...new Set([...importBatch.work.countries.slice(p0.countries.length), ...importBatch.work.ccaa.slice(p0.ccaa.length), ...importBatch.work.prov.slice(p0.prov.length)])];
                    const pk = importBatch.work.peaks.length - p0.peaks.length;
                    return names.length + pk ? names.join(', ') + (pk ? ' y ' + pk + ' cimas' : '') : 'nada nuevo (zona ya desbloqueada)';
                })()}.{importBatch.failed ? ' (' + importBatch.failed + ' archivos no se pudieron leer)' : ''}</p>
                <div className="tu-controls">
                    <button className="file-button is-compact" data-variant="primary" onClick={applyBatch}>{importBatch.tracksOk > 1 ? 'Aplicar lote' : 'Aplicar ruta'}</button>
                    <button className="file-button is-compact" data-variant="secondary" onClick={() => setImportBatch(null)}>Cancelar</button>
                </div>
            </div>
        ) : null}

        {selectedPeak ? (
            <div className="tu-callout">
                <strong>{selectedPeak[0]} <small style={{ fontWeight: 400, opacity: 0.75 }}>{selectedPeak[3]} m</small></strong>
                <p>{progress.peaks.includes(peakId(selectedPeak))
                    ? 'Cima conquistada. Buen trabajo.'
                    : 'Aun sin conquistar: pasa a menos de 1 km de la cima para que cuente.'}</p>
                <div className="tu-controls">
                    <a className="file-button is-compact" data-variant="primary" href={wikilocMapUrl(selectedPeak)} target="_blank" rel="noopener noreferrer">Rutas en Wikiloc</a>
                    <button className="file-button is-compact" data-variant="secondary" onClick={() => setSelectedPeak(null)}>Cerrar</button>
                </div>
            </div>
        ) : null}

        {selectedRegion ? (
            <div className="tu-callout">
                <strong>{selectedRegion.pv || selectedRegion.a || selectedRegion.c}</strong>
                <div>{([
                    ['Pais', selectedRegion.c, COUNTRIES.find((r) => r.n === selectedRegion.c), progress.countries],
                    ['Comunidad', selectedRegion.a, CCAA.find((r) => r.n === selectedRegion.a), progress.ccaa],
                    ['Provincia', selectedRegion.pv, PROV.find((r) => r.n === selectedRegion.pv), progress.prov],
                ] as [string, string | null, Region | undefined, string[]][]).map(([lvl, name, rg, unlocked]) => {
                    if (!name || !rg) return null;
                    const rev = regionRevealedCells(rg, progress.cells);
                    const pct = Math.min(100, rev / regionTotalCells(rg) * 100);
                    return <div key={lvl} className="tu-regionrow">
                        <span className="tu-regionlvl">{lvl}</span>
                        <span className="tu-regionname">{name}</span>
                        <span className={unlocked.includes(name) ? 'tu-regionst on' : 'tu-regionst'}>{unlocked.includes(name) ? 'Conquistada' : 'Sin conquistar'}</span>
                        {rev > 0 ? <span className="tu-regionpct">{pct.toFixed(1).replace('.', ',')}% revelado</span> : null}
                    </div>;
                })}</div>
                <div className="tu-controls">
                    <button className="file-button is-compact" data-variant="secondary" onClick={() => setSelectedRegion(null)}>Cerrar</button>
                </div>
            </div>
        ) : null}
        </> : null}

        {tab === 'progreso' ? <>
            <section className="tu-group"><h2>Tu progreso</h2>
                <dl className="tu-factsdl">{([
                    { label: 'Superficie revelada', value: '~' + fmtAreaShort(progress.cells.length * 1.1), pct: null },
                    { label: 'Paises', value: progress.countries.length + ' de ' + COUNTRIES.length + ' (' + (progress.countries.length / COUNTRIES.length * 100).toFixed(1).replace('.', ',') + '%)', pct: progress.countries.length / COUNTRIES.length },
                    { label: 'Comunidades (ES)', value: progress.ccaa.length + ' de ' + CCAA.length + ' (' + (progress.ccaa.length / CCAA.length * 100).toFixed(1).replace('.', ',') + '%)', pct: progress.ccaa.length / CCAA.length },
                    { label: 'Provincias (ES)', value: progress.prov.length + ' de ' + PROV.length + ' (' + (progress.prov.length / PROV.length * 100).toFixed(1).replace('.', ',') + '%)', pct: progress.prov.length / PROV.length },
                    { label: 'Cimas conquistadas', value: progress.peaks.length + ' de ' + allPeaks.length, pct: allPeaks.length > 0 ? progress.peaks.length / allPeaks.length : 0 },
                    { label: 'Puntos GPS', value: String(progress.points.length), pct: null },
                    { label: 'Racha', value: streak.count > 0 ? streak.count + (streak.count === 1 ? ' dia' : ' dias') : '-', pct: null },
                ] as { label: string; value: string; pct: number | null }[]).map((f) => <div key={f.label} className="tu-factrow"><dt>{f.label}</dt><dd>{f.value}</dd>{f.pct != null ? <div className="tu-bar"><div style={{ width: Math.max(f.pct * 100, f.pct > 0 ? 2 : 0).toFixed(1) + '%' }} /></div> : null}</div>)}</dl>
                <div className="tu-controls"><button className="file-button" data-variant="primary" onClick={shareCard}>Compartir mi mapa</button></div>
            </section>

            <section className="tu-group"><h2>Logros</h2>
                <div className="tu-ach-grid">
                    {ACHIEVEMENTS.map((a) => { const at = achUnlocked[a.id]; return (
                        <div key={a.id} className={'tu-ach' + (at ? ' on' : '')}>
                            <b>{at ? '★ ' : ''}{a.title}</b>
                            <small>{at ? new Date(at).toLocaleDateString('es-ES') : a.hint}</small>
                        </div>); })}
                </div>
            </section>

            {adventures.length ? <section className="tu-group"><h2>Aventuras</h2>
                <ol className="tu-peaklist tu-advlist">
                    {adventures.map((a) => <li key={a.start}>
                        <span className="tu-pkname">{new Date(a.start).toLocaleDateString('es-ES')}<small>{[...a.countries, ...a.ccaa, ...a.prov].join(', ') || 'Sin desbloqueos nuevos'}</small></span>
                        <span className="tu-pkele">{fmtDist(a.km)}</span>
                    </li>)}
                </ol>
            </section> : null}

            {progress.countries.length + progress.ccaa.length + progress.prov.length > 0 ? <section className="tu-group"><h2>Territorio desbloqueado</h2>
                <div className="tu-chips">
                    {progress.countries.map((n) => <span key={'c' + n} className="tu-chip">{n}</span>)}
                    {progress.ccaa.map((n) => <span key={'a' + n} className="tu-chip tu-chip-2">{n}</span>)}
                    {progress.prov.map((n) => <span key={'p' + n} className="tu-chip tu-chip-3">{n}</span>)}
                </div>
            </section> : <section className="tu-group"><div className="tu-callout"><strong>Aun sin territorio</strong><p>Activa el GPS en la pestana Mapa o usa el modo prueba para desbloquear tu primera zona.</p></div></section>}
        </> : null}

        {tab === 'cimas' ? <>
            <section className="tu-group"><h2>Buscar cimas</h2>
                <input className="tu-input tu-input-full" type="search" placeholder="Nombre de la cima (min. 2 letras)" value={peakQuery} onChange={(e) => setPeakQuery(e.target.value)} />
                {peakQuery.trim().length >= 2 ? (
                    peakResults.length ? <ol className="tu-peaklist tu-peaklist-full">
                        {peakResults.map((p) => <li key={peakId(p)}>
                            <span className="tu-pkname">{p[0]}<small>{progress.peaks.includes(peakId(p)) ? 'Conquistada' : 'Sin conquistar'}</small></span>
                            <span className="tu-pkele">{p[3]} m</span>
                            <button className="file-button is-compact" data-variant="secondary" onClick={() => showPeakOnMap(p)}>Ver</button>
                        </li>)}
                    </ol> : <div className="tu-callout"><strong>Sin resultados</strong><p>Prueba con otro nombre: el buscador ignora tildes y mayusculas.</p></div>
                ) : null}
            </section>

            <section className="tu-group"><h2>Cerca de ti</h2>
                {lastPos ? (
                    nearbyPeaks.length ? <ol className="tu-peaklist">
                        {nearbyPeaks.map(({ p, d }) => <li key={peakId(p)}>
                            <span className="tu-pkname">{p[0]}<small>{progress.peaks.includes(peakId(p)) ? 'Conquistada' : 'Sin conquistar'}</small></span>
                            <span className="tu-pkele">{p[3]} m</span>
                            <span className="tu-pkdist">{fmtDist(d / 1000)}</span>
                            <button className="file-button is-compact" data-variant="secondary" onClick={() => showPeakOnMap(p)}>Ver</button>
                        </li>)}
                    </ol> : <div className="tu-callout"><strong>Nada a menos de 100 km</strong><p>No hay cimas del catalogo cerca de tu posicion actual.</p></div>
                ) : <div className="tu-callout"><strong>Que tengo cerca que cuente?</strong><p>Dame tu posicion y te listo las cimas conquistables a menos de 100 km, con distancia.</p>
                    <div className="tu-controls"><button className="file-button is-compact" data-variant="primary" onClick={locateForNearby}>Usar mi posicion</button></div></div>}
            </section>

            <section className="tu-group"><h2>Tus cimas</h2>
                <div className="tu-callout"><strong>{progress.peaks.length} de {allPeaks.length} conquistadas</strong><p>Toca cualquier triangulo del mapa para ver su ficha: altitud, si la has conquistado y rutas para subirla. Una cima cuenta cuando pasas a menos de 1 km.</p></div>
                {conqueredPeaks.length > 0 ? (
                    <ol className="tu-peaklist tu-peaklist-full">
                        {conqueredPeaks.map((p, i) => <li key={peakId(p)}><span className="tu-num">{i + 1}</span><span className="tu-pkname">{p[0]}<small>{p[1].toFixed(3)}, {p[2].toFixed(3)}</small></span><span className="tu-pkele">{p[3]} m</span></li>)}
                    </ol>
                ) : <div className="tu-callout"><strong>Aun no tienes cimas</strong><p>Tu primera cima aparecera aqui en cuanto pases cerca de una.</p></div>}
            </section>
        </> : null}

        {tab === 'ajustes' ? <>
            <section className="tu-group"><h2>Perfil</h2>
                <div className="tu-setrow">
                    {avatar ? <img className="tu-avatar tu-avatar-img" src={avatar} alt="Tu foto de perfil" /> : <div className="tu-avatar">{(prefs.nombre.trim()[0] || '?').toUpperCase()}</div>}
                    <div className="l" style={{ flex: 1 }}>
                        <b>{prefs.nombre.trim() || 'Sin nombre'}</b>
                        <small>Sin cuenta: tu progreso vive en este dispositivo. El login, los rankings y los piques llegan en la fase 2.</small>
                    </div>
                </div>
                <div className="tu-setrow">
                    <div className="l" style={{ flex: 1 }}>
                        <b>Foto de perfil</b>
                        <small>Sale en el saludo y en tu tarjeta de compartir. Se recorta a cuadrado y se guarda en este dispositivo.</small>
                    </div>
                    <div className="tu-controls">
                        <label className="file-button is-compact" data-variant="primary">Subir foto
                            <input type="file" accept="image/*" aria-label="Subir foto de perfil" style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }} onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) processAvatar(f); e.currentTarget.value = ''; }} />
                        </label>
                        {avatar ? <button className="file-button is-compact" data-variant="secondary" onClick={() => setAvatar('')}>Quitar</button> : null}
                    </div>
                </div>
                <div className="tu-setrow">
                    <div className="l" style={{ flex: 1 }}>
                        <b>Nombre visible</b>
                        <small>Asi te veran tus amigos cuando lleguen los rankings.</small>
                    </div>
                    <input className="tu-input" type="text" maxLength={24} placeholder="Tu nombre" value={prefs.nombre} onChange={(e) => setPrefs({ nombre: e.target.value })} />
                </div>
                <div className="tu-setrow">
                    <div className="l" style={{ flex: 1 }}>
                        <b>Cuenta</b>
                        <small>Necesaria para sincronizar entre dispositivos y rankings.</small>
                    </div>
                    <button className="file-button is-compact" data-variant="secondary" disabled style={{ opacity: 0.5, cursor: 'default' }}>Crear cuenta (proximamente)</button>
                </div>
            </section>

            <section className="tu-group"><h2>Mapa</h2>
                <div className="tu-setrow">
                    <div className="l" style={{ flex: 1 }}>
                        <b>Oscuridad de la niebla</b>
                        <small>Mas baja = se ve mas el terreno sin descubrir.</small>
                    </div>
                    <input type="range" min={0.4} max={0.9} step={0.02} value={prefs.fog} onChange={(e) => setPrefs({ fog: parseFloat(e.target.value) })} style={{ width: 130 }} />
                </div>
                <div className="tu-setrow">
                    <div className="l" style={{ flex: 1 }}>
                        <b>Nombres de cimas</b>
                        <small>Etiquetas con nombre y altitud al acercar el zoom.</small>
                    </div>
                    <input type="checkbox" className="tu-check" checked={prefs.peakLabels} onChange={(e) => setPrefs({ peakLabels: e.target.checked })} />
                </div>
                <div className="tu-setrow">
                    <div className="l" style={{ flex: 1 }}>
                        <b>Bienvenida</b>
                        <small>Vuelve a mostrar la pantalla de inicio al abrir la app.</small>
                    </div>
                    <button className="file-button is-compact" data-variant="secondary" onClick={() => setPrefs({ welcomed: false })}>Mostrar de nuevo</button>
                </div>
            </section>

            <section className="tu-group"><h2>Unidades</h2>
                <div className="tu-setrow">
                    <div className="l" style={{ flex: 1 }}>
                        <b>Distancias y superficie</b>
                    </div>
                    <div className="tu-controls" style={{ margin: 0 }}>
                        <button className="file-button is-compact" data-variant={imp ? 'secondary' : 'primary'} onClick={() => setPrefs({ units: 'metric' })}>km</button>
                        <button className="file-button is-compact" data-variant={imp ? 'primary' : 'secondary'} onClick={() => setPrefs({ units: 'imperial' })}>mi</button>
                    </div>
                </div>
            </section>

            <section className="tu-group"><h2>Datos</h2>
                <div className="tu-io">
                    <textarea className="tu-textarea" value={ioText} onChange={(e) => setIoText(e.target.value)} placeholder="Aqui aparece tu progreso para exportarlo; pega uno anterior para importarlo." rows={3} />
                    <div className="tu-controls">
                        <button className="file-button is-compact" data-variant="secondary" onClick={() => setIoText(JSON.stringify({ v: 2, progress: progressRef.current, achievements: achUnlocked, streak, adventures, profile: { nombre: prefs.nombre, avatar } }))}>Exportar</button>
                        <button className="file-button is-compact" data-variant="secondary" onClick={() => {
                            try {
                                const data = JSON.parse(ioText);
                                if (data && Array.isArray(data.cells)) {
                                    const next = { ...EMPTY, ...data }; setProgress(next); saveProgress(next); setToast('Progreso importado');
                                } else if (data && data.v >= 2 && data.progress && Array.isArray(data.progress.cells)) {
                                    const next = { ...EMPTY, ...data.progress }; setProgress(next); saveProgress(next);
                                    if (data.achievements && typeof data.achievements === 'object') { setAchUnlocked(data.achievements); saveAch(data.achievements); }
                                    if (data.streak && typeof data.streak.count === 'number') { setStreak(data.streak); saveJson(STREAK_KEY, data.streak); }
                                    if (Array.isArray(data.adventures)) { setAdventures(data.adventures); saveJson(ADVS_KEY, data.adventures); }
                                    if (data.profile && typeof data.profile === 'object') {
                                        if (typeof data.profile.nombre === 'string') setPrefs({ nombre: data.profile.nombre });
                                        if (typeof data.profile.avatar === 'string') setAvatar(data.profile.avatar);
                                    }
                                    setToast('Copia completa importada');
                                } else setToast('Formato no valido');
                            } catch { setToast('Formato no valido'); }
                        }}>Importar</button>
                        <label className="file-button is-compact" data-variant="secondary" style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                            {batchBusy ? 'Leyendo...' : 'Importar rutas'}
                            <input type="file" multiple accept=".gpx,.fit,.zip,.gz,application/gpx+xml" aria-label="Importar rutas" style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }} onChange={(e) => { const input = e.currentTarget; void onImportFiles(input.files).finally(() => { input.value = ''; }); }} />
                        </label>
                        <button className="file-button is-compact" data-variant="secondary" onClick={() => {
                            if (!confirmReset) { setConfirmReset(true); return; }
                            setConfirmReset(false); setProgress({ ...EMPTY }); saveProgress({ ...EMPTY }); setToast('Progreso reiniciado');
                        }}>{confirmReset ? 'Seguro? Toca otra vez' : 'Reiniciar'}</button>
                    </div>
                </div>
                <p className="tu-more">Importar rutas acepta GPX, FIT, .gz sueltos y el ZIP completo de exportacion de Strava o Garmin Connect.</p>
            </section>

            <footer className="tu-closing">TerraUnlock v1.5 - tu progreso se guarda en este dispositivo.</footer>
        </> : null}

        {banners.length ? (
            <div className="tu-territory" role="status">
                <div className="tu-terr-ico">⚑</div>
                <div className="tu-terr-body">
                    <strong>{banners[0].title}</strong>
                    <small>{banners[0].sub}{banners.length > 1 ? ' · +' + (banners.length - 1) + ' mas a continuacion' : ''}</small>
                </div>
                <button className="file-button is-compact" data-variant="primary" onClick={() => shareCard()}>Compartir</button>
                <button className="tu-terr-x" aria-label="Cerrar aviso" onClick={() => setBanners((b) => b.slice(1))}>×</button>
            </div>
        ) : null}

        {celebration.length ? (
            <div className="tu-celebration">
                <div className="tu-celeb-card">
                    <div className="tu-celeb-ico">★</div>
                    <h2>Logro desbloqueado</h2>
                    <strong>{celebration[0].title}</strong>
                    <p>{celebration[0].hint}</p>
                    {celebration.length > 1 ? <small>y {celebration.length - 1} mas a continuacion</small> : null}
                    <div className="tu-controls" style={{ justifyContent: 'center' }}>
                        <button className="file-button is-compact" data-variant="primary" onClick={() => shareCard()}>Compartir</button>
                        <button className="file-button is-compact" data-variant="secondary" onClick={() => setCelebration((c) => c.slice(1))}>Seguir explorando</button>
                    </div>
                </div>
            </div>
        ) : null}

        {advSummary ? (
            <div className="tu-celebration">
                <div className="tu-celeb-card">
                    <div className="tu-celeb-ico">⚑</div>
                    <h2>Aventura terminada</h2>
                    <strong>{fmtDist(advSummary.km)}</strong>
                    <p>{advSummary.points} puntos GPS{[...advSummary.countries, ...advSummary.ccaa, ...advSummary.prov].length ? ' · Desbloqueos: ' + [...advSummary.countries, ...advSummary.ccaa, ...advSummary.prov].join(', ') : ''}{advSummary.peaks.length ? ' · ' + advSummary.peaks.length + ' cimas' : ''}{![...advSummary.countries, ...advSummary.ccaa, ...advSummary.prov, ...advSummary.peaks].length ? ' · Sin desbloqueos nuevos esta vez' : ''}</p>
                    <div className="tu-controls" style={{ justifyContent: 'center' }}>
                        <button className="file-button is-compact" data-variant="primary" onClick={() => shareCard()}>Compartir</button>
                        <button className="file-button is-compact" data-variant="secondary" onClick={() => setAdvSummary(null)}>Cerrar</button>
                    </div>
                </div>
            </div>
        ) : null}

        {toast ? <div className="tu-toast">{toast}</div> : null}

        <nav className="tu-nav">
            <div className="tu-brand">TerraUnlock</div>
            {([
                ['mapa', '◉', 'Mapa'],
                ['progreso', '◆', 'Progreso'],
                ['cimas', '▲', 'Cimas'],
                ['ajustes', '⚙', 'Ajustes'],
            ] as const).map(([id, g, label]) => (
                <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}><span className="g">{g}</span>{label}</button>
            ))}
        </nav>

        {!prefs.welcomed ? (
            <div className="tu-welcome">
                <img src="./icons/icon-192.png" alt="TerraUnlock" />
                <h1>TerraUnlock</h1>
                <p className="tu-intro" style={{ maxWidth: 340 }}>El mundo empieza cubierto de niebla y se revela donde pisas. Conquista paises, comunidades, provincias y cimas con tu GPS real.</p>
                <ul>
                    <li>Activa el GPS y sal: la niebla se abre a tu paso.</li>
                    <li>57.000+ cimas marcadas: toca una para ver sus rutas.</li>
                    <li>Importa tus rutas (GPX, FIT o el ZIP de Strava/Garmin).</li>
                </ul>
                <button className="file-button" data-variant="primary" onClick={() => setPrefs({ welcomed: true })}>Empezar a conquistar</button>
            </div>
        ) : null}
    </div>}
