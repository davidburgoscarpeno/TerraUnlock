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
function peakId(p: Peak) { return p[0] + '|' + p[1] + '|' + p[2]; }

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
        const ctry = regionAt(COUNTRIES, q[1], q[0]);
        if (ctry && !countries.has(ctry)) { countries.add(ctry); nCountries.push(ctry); }
        if (q[1] >= SPAIN_BBOX[0] && q[1] <= SPAIN_BBOX[2] && q[0] >= SPAIN_BBOX[1] && q[0] <= SPAIN_BBOX[3]) {
            const a = regionAt(CCAA, q[1], q[0]);
            if (a && !ccaa.has(a)) { ccaa.add(a); nCcaa.push(a); }
            const pv = regionAt(PROV, q[1], q[0]);
            if (pv && !prov.has(pv)) { prov.add(pv); nProv.push(pv); }
        }
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
    const [gpsMsg, setGpsMsg] = useState('');
    const [lastPos, setLastPos] = useState<[number, number] | null>(null);
    const [toast, setToast] = useState('');
    const [ioText, setIoText] = useState('');
    const [confirmReset, setConfirmReset] = useState(false);
    const [importTrack, setImportTrack] = useState<TrackScan | null>(null);
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
        if (isNewPoint) {
            const ctry = regionAt(COUNTRIES, lon, lat);
            if (ctry && !next.countries.includes(ctry)) { next.countries = [...next.countries, ctry]; news.push('Pais desbloqueado: ' + ctry); }
            if (lon >= SPAIN_BBOX[0] && lon <= SPAIN_BBOX[2] && lat >= SPAIN_BBOX[1] && lat <= SPAIN_BBOX[3]) {
                const a = regionAt(CCAA, lon, lat);
                if (a && !next.ccaa.includes(a)) { next.ccaa = [...next.ccaa, a]; news.push('Comunidad desbloqueada: ' + a); }
                const pv = regionAt(PROV, lon, lat);
                if (pv && !next.prov.includes(pv)) { next.prov = [...next.prov, pv]; news.push('Provincia desbloqueada: ' + pv); }
            }
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
        if (isNewCell || isNewPoint || news.length) { setProgress(next); saveProgress(next); }
        setLastPos([lat, lon]);
    };

    const onGpxFile = async (f: File | undefined) => {
        if (!f) return;
        try {
            const { name, pts } = parseGpx(await f.text());
            const scan = scanTrack(name, pts, progressRef.current, peakGrid);
            setImportTrack(scan);
            // Encuadrar el track
            let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
            for (const q of scan.pts) { if (q[0] < minLat) minLat = q[0]; if (q[0] > maxLat) maxLat = q[0]; if (q[1] < minLon) minLon = q[1]; if (q[1] > maxLon) maxLon = q[1]; }
            const w = wrapRef.current?.clientWidth || 800, h = wrapRef.current?.clientHeight || 500;
            const spanLon = Math.max(0.001, maxLon - minLon), spanLat = Math.max(0.001, maxLat - minLat);
            const zx = Math.log2((w * 0.7 * 360) / (256 * spanLon));
            const zy = Math.log2((h * 0.7 * 360) / (256 * spanLat * 1.4));
            setViewPersist({ lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2, z: Math.max(3, Math.min(14, Math.min(zx, zy))) });
        } catch (e) { setToast('GPX no valido: ' + (e instanceof Error ? e.message : 'error')); }
    };

    const applyTrack = () => {
        const t = importTrack; if (!t) return;
        const p = progressRef.current;
        const next: Progress = {
            cells: t.cells, points: [...p.points, ...t.pts],
            countries: [...p.countries, ...t.countries],
            ccaa: [...p.ccaa, ...t.ccaa],
            prov: [...p.prov, ...t.prov],
            peaks: [...p.peaks, ...t.peaks],
        };
        setProgress(next); saveProgress(next); setImportTrack(null);
        const parts: string[] = [];
        if (t.countries.length) parts.push(t.countries.length + ' paises');
        if (t.ccaa.length) parts.push(t.ccaa.length + ' CCAA');
        if (t.prov.length) parts.push(t.prov.length + ' provincias');
        if (t.peaks.length) parts.push(t.peaks.length + ' cimas');
        setToast('Ruta aplicada (' + t.km.toFixed(1) + ' km): ' + (parts.length ? '+' + parts.join(', +') : 'zona ya desbloqueada'));
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
            fx.fillStyle = 'rgba(3,6,10,0.68)'; fx.fillRect(0, 0, w, h);
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

        // Track GPX en preview
        if (importTrack) {
            ctx.save();
            ctx.strokeStyle = '#f0b429'; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
            ctx.shadowColor = 'rgba(240,180,41,0.55)'; ctx.shadowBlur = 9;
            ctx.beginPath();
            let started = false;
            for (const q of importTrack.pts) {
                const pt = project(q[1], q[0], z);
                const x = sx(pt.x), y = sy(pt.y);
                if (x < -60 || x > w + 60 || y < -60 || y > h + 60) { started = false; continue; }
                if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
            }
            ctx.stroke();
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
            if (z >= 9) {
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
    }, [view, progress, lastPos, tileTick, importTrack, allPeaks, selectedPeak]);

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
                    if (best) { setSelectedPeak(best); dragStart.current = null; return; }
                }
                if (simMode) {
                    const ll = unproject(pc.x + (mx - w / 2), pc.y + (my - h / 2), v.z);
                    addPoint(ll.lat, ll.lon);
                } else if (selectedPeak) setSelectedPeak(null);
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

    const km2 = (progress.cells.length * 1.1).toFixed(0);
    const conqueredPeaks = progress.peaks.map((id) => peakById.get(id)).filter((p): p is Peak => !!p);

    return <div className="tu-app">
        <header className="tu-header">
            <div className="tu-header-row"><h1>TerraUnlock</h1><span className="tu-fact">{km2} km2 revelados</span></div>
            <p className="tu-intro">El mundo empieza cubierto de niebla y se revela donde pisas. Activa el GPS y sal a conquistar: paises, comunidades, provincias y cimas cuentan para tu progreso.</p>
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
            {toast ? <div className="tu-toast">{toast}</div> : null}
            <div className="tu-attr">Esri, Maxar, Earthstar Geographics</div>
        </div>

        <div className="tu-controls">
            <button className="file-button is-compact" data-variant={gpsOn ? 'primary' : 'secondary'} onClick={() => setGpsOn(!gpsOn)}>{gpsOn ? 'GPS activado' : 'Activar GPS'}</button>
            <button className="file-button is-compact" data-variant="secondary" onClick={centerOnMe}>Centrar en mi</button>
            <button className="file-button is-compact" data-variant={simMode ? 'primary' : 'secondary'} onClick={() => setSimMode(!simMode)}>{simMode ? 'Modo prueba: ON' : 'Modo prueba'}</button>
            <button className="file-button is-compact" data-variant="secondary" onClick={() => zoomAt((wrapRef.current?.clientWidth || 0) / 2, (wrapRef.current?.clientHeight || 0) / 2, 1)}>+</button>
            <button className="file-button is-compact" data-variant="secondary" onClick={() => zoomAt((wrapRef.current?.clientWidth || 0) / 2, (wrapRef.current?.clientHeight || 0) / 2, -1)}>-</button>
        </div>
        {gpsMsg ? <div className="tu-callout tu-warn"><strong>GPS</strong><p>{gpsMsg}</p></div> : null}
        {simMode ? <div className="tu-callout"><strong>Modo prueba</strong><p>Toca cualquier punto del mapa para simular que has estado ahi: revela niebla y desbloquea igual que el GPS.</p></div> : null}

        {importTrack ? (
            <div className="tu-callout">
                <strong>{importTrack.name}</strong>
                <p>{importTrack.pts.length} puntos, {importTrack.km.toFixed(1)} km. Va a revelar la niebla de todo el recorrido y desbloqueara: {(() => { const names = [...new Set([...importTrack.countries, ...importTrack.ccaa, ...importTrack.prov])]; return names.length + importTrack.peaks.length ? names.join(', ') + (importTrack.peaks.length ? ' y ' + importTrack.peaks.length + ' cimas' : '') : 'nada nuevo (zona ya desbloqueada)'; })()}.</p>
                <div className="tu-controls">
                    <button className="file-button is-compact" data-variant="primary" onClick={applyTrack}>Aplicar ruta</button>
                    <button className="file-button is-compact" data-variant="secondary" onClick={() => setImportTrack(null)}>Cancelar</button>
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
                    <a className="file-button is-compact" data-variant="primary" href={'https://es.wikiloc.com/rutas?q=' + encodeURIComponent(selectedPeak[0])} target="_blank" rel="noopener noreferrer">Rutas en Wikiloc</a>
                    <button className="file-button is-compact" data-variant="secondary" onClick={() => setSelectedPeak(null)}>Cerrar</button>
                </div>
            </div>
        ) : null}

        <section className="tu-group"><h2>Tu progreso</h2>
            <dl className="tu-factsdl">{[
                { label: 'Superficie revelada', value: '~' + km2 + ' km2' },
                { label: 'Paises', value: progress.countries.length + ' de ' + COUNTRIES.length },
                { label: 'Comunidades (ES)', value: progress.ccaa.length + ' de ' + CCAA.length },
                { label: 'Provincias (ES)', value: progress.prov.length + ' de ' + PROV.length },
                { label: 'Cimas conquistadas', value: String(progress.peaks.length) },
                { label: 'Puntos GPS', value: String(progress.points.length) },
            ].map((f) => <div key={f.label} className="tu-factrow"><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>
        </section>

        {progress.countries.length + progress.ccaa.length + progress.prov.length > 0 ? <section className="tu-group"><h2>Territorio desbloqueado</h2>
            <div className="tu-chips">
                {progress.countries.map((n) => <span key={'c' + n} className="tu-chip">{n}</span>)}
                {progress.ccaa.map((n) => <span key={'a' + n} className="tu-chip tu-chip-2">{n}</span>)}
                {progress.prov.map((n) => <span key={'p' + n} className="tu-chip tu-chip-3">{n}</span>)}
            </div>
        </section> : null}

        {conqueredPeaks.length > 0 ? <section className="tu-group"><h2>Tus cimas</h2>
            <ol className="tu-peaklist">
                {conqueredPeaks.slice(0, 15).map((p, i) => <li key={peakId(p)}><span className="tu-num">{i + 1}</span><span className="tu-pkname">{p[0]}<small>{p[1].toFixed(3)}, {p[2].toFixed(3)}</small></span><span className="tu-pkele">{p[3]} m</span></li>)}
            </ol>
            {conqueredPeaks.length > 15 ? <div className="tu-more">y {conqueredPeaks.length - 15} cimas mas</div> : null}
        </section> : null}

        <section className="tu-group"><h2>Copia de seguridad</h2>
            <div className="tu-io">
                <textarea className="tu-textarea" value={ioText} onChange={(e) => setIoText(e.target.value)} placeholder="Aqui aparece tu progreso para exportarlo; pega uno anterior para importarlo." rows={3} />
                <div className="tu-controls">
                    <button className="file-button is-compact" data-variant="secondary" onClick={() => setIoText(JSON.stringify(progressRef.current))}>Exportar</button>
                    <button className="file-button is-compact" data-variant="secondary" onClick={() => {
                        try {
                            const p = JSON.parse(ioText);
                            if (Array.isArray(p.cells)) { const next = { ...EMPTY, ...p }; setProgress(next); saveProgress(next); setToast('Progreso importado'); }
                            else setToast('Formato no valido');
                        } catch { setToast('Formato no valido'); }
                    }}>Importar</button>
                    <label className="file-button is-compact" data-variant="secondary" style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer' }}>
                        Importar GPX
                        <input type="file" accept=".gpx,application/gpx+xml" aria-label="Importar GPX" style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }} onChange={(e) => { const input = e.currentTarget; void onGpxFile(input.files?.[0]).finally(() => { input.value = ''; }); }} />
                    </label>
                    <button className="file-button is-compact" data-variant="secondary" onClick={() => {
                        if (!confirmReset) { setConfirmReset(true); return; }
                        setConfirmReset(false); setProgress({ ...EMPTY }); saveProgress({ ...EMPTY }); setToast('Progreso reiniciado');
                    }}>{confirmReset ? 'Seguro? Toca otra vez' : 'Reiniciar'}</button>
                </div>
            </div>
        </section>

        <footer className="tu-closing">Tu progreso se guarda en este dispositivo. Cuentas, rankings y piques con amigos llegan en la fase 2.</footer>
    </div>;
}
