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
const REVEAL_M = 1300;
const PEAK_M = 250;
const STORE_KEY = 'terraunlock.progress.v1';
const VIEW_KEY = 'terraunlock.view.v1';
const SPAIN_BBOX = [-9.7, 35.0, 4.5, 44.2];
const ALL_PEAKS: Peak[] = [...PEAKS_ES, ...PEAKS_WORLD];

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

export function App() {
    const [progress, setProgress] = useState<Progress>(loadProgress);
    const progressRef = useRef(progress); progressRef.current = progress;
    const [view, setView] = useState(() => {
        try { const v = JSON.parse(localStorage.getItem(VIEW_KEY) || ''); if (v && typeof v.lon === 'number') return v as { lon: number; lat: number; z: number }; } catch { /* sin vista guardada */ }
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
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const wrapRef = useRef<HTMLDivElement>(null);
    const fogRef = useRef<HTMLCanvasElement | null>(null);
    const wakeRef = useRef<{ release?: () => Promise<void> } | null>(null);

    const peakGrid = useMemo(() => {
        const g = new Map<string, Peak[]>();
        for (const p of ALL_PEAKS) {
            const k = Math.floor(p[1] * 2) + ',' + Math.floor(p[2] * 2);
            const arr = g.get(k); if (arr) arr.push(p); else g.set(k, [p]);
        }
        return g;
    }, []);
    const peakById = useMemo(() => { const m = new Map<string, Peak>(); for (const p of ALL_PEAKS) m.set(peakId(p), p); return m; }, []);

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
        for (const rg of COUNTRIES) drawRegion(rg, '#1d2c3e', 'rgba(130,170,200,0.42)', 1);
        if (z >= 3.5) for (const rg of CCAA) drawRegion(rg, null, 'rgba(120,200,180,0.40)', 1);
        if (z >= 5) for (const rg of PROV) drawRegion(rg, null, 'rgba(120,200,180,0.30)', 0.7);

        // Niebla en capa aparte
        let fog = fogRef.current;
        if (!fog) { fog = document.createElement('canvas'); fogRef.current = fog; }
        fog.width = w * dpr; fog.height = h * dpr;
        const fx = fog.getContext('2d');
        if (fx) {
            fx.setTransform(dpr, 0, 0, dpr, 0, 0);
            fx.fillStyle = 'rgba(4,7,11,0.58)'; fx.fillRect(0, 0, w, h);
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
        for (const rg of COUNTRIES) if (cSet.has(rg.n)) drawRegion(rg, 'rgba(46,184,152,0.42)', 'rgba(140,240,215,0.92)', 1.6);
        if (z >= 3.5) for (const rg of CCAA) if (aSet.has(rg.n)) drawRegion(rg, 'rgba(46,184,152,0.30)', 'rgba(140,240,215,0.75)', 1.2);
        if (z >= 5) for (const rg of PROV) if (pSet.has(rg.n)) drawRegion(rg, 'rgba(46,184,152,0.24)', 'rgba(140,240,215,0.65)', 1.0);

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

        // Cimas
        if (z >= 5.5) {
            let drawn = 0;
            const step = z < 7 ? 3 : 1;
            for (let i = 0; i < ALL_PEAKS.length && drawn < 500; i += step) {
                const pk = ALL_PEAKS[i];
                if (pk[2] < tl.lon || pk[2] > br.lon || pk[1] < br.lat || pk[1] > tl.lat) continue;
                const pt = project(pk[2], pk[1], z);
                const x = sx(pt.x), y = sy(pt.y);
                const won = pkSet.has(peakId(pk));
                ctx.beginPath();
                ctx.moveTo(x, y - 5); ctx.lineTo(x - 4.5, y + 3.5); ctx.lineTo(x + 4.5, y + 3.5); ctx.closePath();
                ctx.fillStyle = won ? '#f0b429' : 'rgba(200,212,222,0.6)';
                ctx.fill();
                if (z >= 10.5 && (won || pk[3] >= 3000)) {
                    ctx.font = '10px sans-serif'; ctx.fillStyle = won ? '#f0b429' : 'rgba(220,228,235,0.75)';
                    ctx.fillText(pk[0] + ' ' + pk[3] + 'm', x, y - 11);
                }
                drawn++;
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
    }, [view, progress, lastPos]);

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
        const nl = unproject(wx * scale - (mx - w / 2), wy * scale - (my - h / 2), nz);
        setViewPersist({ lon: nl.lon, lat: nl.lat, z: nz });
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
        if (wasTap && simMode) {
            const wrap = wrapRef.current; if (!wrap) return;
            const rect = wrap.getBoundingClientRect();
            const v = viewRef.current;
            const pc = project(v.lon, v.lat, v.z);
            const ll = unproject(pc.x + (e.clientX - rect.left - wrap.clientWidth / 2), pc.y + (e.clientY - rect.top - wrap.clientHeight / 2), v.z);
            addPoint(ll.lat, ll.lon);
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
