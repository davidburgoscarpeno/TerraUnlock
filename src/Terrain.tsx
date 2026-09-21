// Tarjeta "Terreno" de la ficha de cima: relieve con curvas de nivel (2D) y vista 3D giratoria.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Peak } from './data/peaks_es';
import { loadElevGrid, niceLevels, contourSegments, hillshade, hypoColor } from './terrain';
import type { ElevGrid } from './terrain';

type Mode = '3d' | '2d';
const SIZE = 640; // resolucion de backing del canvas (se escala por CSS)

function fmtM(v: number): string { return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }

function draw2D(cv: HTMLCanvasElement, g: ElevGrid, levels: number[], step: number, shade: Uint8ClampedArray, peak: Peak) {
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const n = g.n, s = SIZE / n;
    // relieve hipsometrico + sombra
    const off = document.createElement('canvas');
    off.width = n; off.height = n;
    const octx = off.getContext('2d');
    if (!octx) return;
    const im = octx.createImageData(n, n);
    const amp = Math.max(1, g.max - g.min);
    for (let k = 0; k < n * n; k++) {
        const e = g.data[k];
        const c = e <= 0.5 ? [52, 94, 130] : hypoColor((e - Math.max(0, g.min)) / Math.max(1, g.max - Math.max(0, g.min)));
        const f = 0.62 + 0.38 * (shade[k] / 255);
        im.data[k * 4] = c[0] * f; im.data[k * 4 + 1] = c[1] * f; im.data[k * 4 + 2] = c[2] * f; im.data[k * 4 + 3] = 255;
    }
    octx.putImageData(im, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, SIZE, SIZE);
    // curvas de nivel
    ctx.lineJoin = 'round';
    levels.forEach((lv, li) => {
        const segs = contourSegments(g.data, n, lv);
        const master = li % 5 === 4;
        ctx.beginPath();
        for (let q = 0; q < segs.length; q += 4) {
            ctx.moveTo(segs[q] * s, segs[q + 1] * s);
            ctx.lineTo(segs[q + 2] * s, segs[q + 3] * s);
        }
        ctx.strokeStyle = master ? 'rgba(40,24,10,0.55)' : 'rgba(40,24,10,0.30)';
        ctx.lineWidth = master ? 1.6 : 0.8;
        ctx.stroke();
    });
    // marca de la cima (centro del recorte) con etiqueta
    const cx = SIZE / 2, cy = SIZE / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 12); ctx.lineTo(cx + 10, cy + 7); ctx.lineTo(cx - 10, cy + 7); ctx.closePath();
    ctx.fillStyle = '#14755f'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#eafff7'; ctx.stroke();
    ctx.font = '700 22px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.textAlign = 'center';
    const label = peak[0] + ' · ' + fmtM(peak[3]) + ' m';
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(8,12,18,0.8)'; ctx.strokeText(label, cx, cy + 34);
    ctx.fillStyle = '#fff'; ctx.fillText(label, cx, cy + 34);
    // escala (1 km)
    const barPx = 1000 / g.mpp * s;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(18, SIZE - 20); ctx.lineTo(18 + barPx, SIZE - 20); ctx.stroke();
    ctx.font = '600 17px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(8,12,18,0.8)';
    ctx.strokeText('1 km', 18, SIZE - 28);
    ctx.fillStyle = '#fff'; ctx.fillText('1 km', 18, SIZE - 28);
    // norte
    ctx.font = '700 20px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.textAlign = 'right';
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(8,12,18,0.8)';
    ctx.strokeText('N', SIZE - 18, 32);
    ctx.fillStyle = '#fff'; ctx.fillText('N', SIZE - 18, 32);
    ctx.beginPath(); ctx.moveTo(SIZE - 21, 40); ctx.lineTo(SIZE - 14, 56); ctx.lineTo(SIZE - 28, 56); ctx.closePath();
    ctx.fillStyle = '#eafff7'; ctx.fill();
    void step;
}

function draw3D(cv: HTMLCanvasElement, g: ElevGrid, shade: Uint8ClampedArray, azimDeg: number, peak: Peak) {
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const W = SIZE, H = Math.round(SIZE * 0.78);
    const M = 110; // rejilla reducida para pintar
    const n = g.n;
    const st = (n - 1) / (M - 1);
    const az = azimDeg * Math.PI / 180, cosA = Math.cos(az), sinA = Math.sin(az);
    const amp = Math.max(1, g.max - g.min);
    const sc = W / (M * 1.7);
    const zK = (H * 0.34) / amp; // exageracion vertical
    const fY = 0.52;           // achatamiento del plano
    const cyOff = H * 0.60;
    // fondo cielo
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0b1017'); bg.addColorStop(1, '#14303a');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    const base = Math.max(0, g.min);
    const pz = (e: number) => (e - base) * zK;
    // puntos proyectados
    const sx = new Float32Array(M * M), sy = new Float32Array(M * M), dep = new Float32Array(M * M);
    for (let j = 0; j < M; j++) {
        for (let i = 0; i < M; i++) {
            const gi = Math.round(i * st), gj = Math.round(j * st);
            const e = g.data[gj * n + gi];
            const dx = i - (M - 1) / 2, dy = j - (M - 1) / 2;
            const rx = dx * cosA - dy * sinA, ry = dx * sinA + dy * cosA;
            const k = j * M + i;
            sx[k] = W / 2 + rx * sc;
            sy[k] = cyOff + ry * sc * fY - pz(e);
            dep[k] = ry;
        }
    }
    // quads de atras hacia delante
    interface Quad { d: number; x: number[]; y: number[]; c: string; }
    const quads: Quad[] = [];
    const sea: [number, number, number] = [52, 94, 130];
    for (let j = 0; j < M - 1; j++) {
        for (let i = 0; i < M - 1; i++) {
            const k = j * M + i;
            const gi = Math.round((i + 0.5) * st), gj = Math.round((j + 0.5) * st);
            const e = g.data[gj * n + gi];
            const c0 = e <= 0.5 ? sea : hypoColor((e - base) / Math.max(1, g.max - base));
            const sh = 0.62 + 0.38 * (shade[gj * n + gi] / 255);
            quads.push({
                d: (dep[k] + dep[k + 1] + dep[k + M] + dep[k + M + 1]) / 4,
                x: [sx[k], sx[k + 1], sx[k + M + 1], sx[k + M]],
                y: [sy[k], sy[k + 1], sy[k + M + 1], sy[k + M]],
                c: 'rgb(' + Math.round(c0[0] * sh) + ',' + Math.round(c0[1] * sh) + ',' + Math.round(c0[2] * sh) + ')',
            });
        }
    }
    quads.sort((a, b) => a.d - b.d);
    for (const q of quads) {
        ctx.beginPath();
        ctx.moveTo(q.x[0], q.y[0]);
        ctx.lineTo(q.x[1], q.y[1]); ctx.lineTo(q.x[2], q.y[2]); ctx.lineTo(q.x[3], q.y[3]);
        ctx.closePath();
        ctx.fillStyle = q.c;
        ctx.fill();
        // mismo color en el borde: cierra las juntas entre quads (efecto malla)
        ctx.strokeStyle = q.c;
        ctx.lineWidth = 0.8;
        ctx.stroke();
    }
    // mastil de la cima
    const ec = g.data[((n - 1) / 2 | 0) * n + ((n - 1) / 2 | 0)];
    const px = W / 2, py = cyOff - pz(ec);
    ctx.strokeStyle = '#eafff7'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py - 44); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px, py - 44); ctx.lineTo(px + 26, py - 37); ctx.lineTo(px, py - 30); ctx.closePath();
    ctx.fillStyle = '#14755f'; ctx.fill();
    ctx.font = '700 20px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.textAlign = 'center';
    const label = peak[0] + ' · ' + fmtM(peak[3]) + ' m';
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(8,12,18,0.85)'; ctx.strokeText(label, W / 2, 30);
    ctx.fillStyle = '#fff'; ctx.fillText(label, W / 2, 30);
}

export default function TerrainCard({ peak }: { peak: Peak }) {
    const [grid, setGrid] = useState<ElevGrid | null>(null);
    const [err, setErr] = useState(false);
    const [mode, setMode] = useState<Mode>('3d');
    const [azim, setAzim] = useState(40);
    const [retry, setRetry] = useState(0);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const drag = useRef<{ x: number; az: number } | null>(null);

    useEffect(() => {
        let dead = false;
        setGrid(null); setErr(false);
        loadElevGrid(peak[1], peak[2])
            .then((g) => { if (!dead) setGrid(g); })
            .catch(() => { if (!dead) setErr(true); });
        return () => { dead = true; };
    }, [peak, retry]);

    const lv = useMemo(() => (grid ? niceLevels(grid.min, grid.max) : null), [grid]);
    const shade = useMemo(() => (grid ? hillshade(grid.data, grid.n, grid.mpp) : null), [grid]);

    useEffect(() => {
        const cv = canvasRef.current;
        if (!cv || !grid || !lv || !shade) return;
        if (mode === '2d') draw2D(cv, grid, lv.levels, lv.step, shade, peak);
        else draw3D(cv, grid, shade, azim, peak);
    }, [grid, lv, shade, mode, azim, peak]);

    const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        drag.current = { x: e.clientX, az: azim };
        e.currentTarget.setPointerCapture(e.pointerId);
    };
    const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (!drag.current) return;
        setAzim(drag.current.az + (e.clientX - drag.current.x) * 0.35);
    };
    const onUp = () => { drag.current = null; };

    return (
        <div className="tu-terrain">
            {err ? (
                <div className="tu-terrnote">
                    No se pudo cargar la elevacion del terreno (hace falta conexion la primera vez).{' '}
                    <button className="file-button is-compact" data-variant="secondary" onClick={() => setRetry((r) => r + 1)}>Reintentar</button>
                </div>
            ) : !grid ? (
                <div className="tu-terrnote">Cargando terreno...</div>
            ) : (
                <>
                    <canvas
                        ref={canvasRef}
                        width={SIZE}
                        height={mode === '2d' ? SIZE : Math.round(SIZE * 0.78)}
                        onPointerDown={mode === '3d' ? onDown : undefined}
                        onPointerMove={mode === '3d' ? onMove : undefined}
                        onPointerUp={mode === '3d' ? onUp : undefined}
                    />
                    <div className="tu-terrbar">
                        <button className="file-button is-compact" data-variant={mode === '3d' ? 'primary' : 'secondary'} onClick={() => setMode('3d')}>3D</button>
                        <button className="file-button is-compact" data-variant={mode === '2d' ? 'primary' : 'secondary'} onClick={() => setMode('2d')}>Curvas</button>
                        <span className="tu-terrnote">
                            {mode === '2d'
                                ? 'Curvas cada ' + lv!.step + ' m · ' + fmtM(grid.min) + '-' + fmtM(grid.max) + ' m'
                                : 'Arrastra para girar · ' + fmtM(grid.min) + '-' + fmtM(grid.max) + ' m'}
                        </span>
                    </div>
                    <div className="tu-terrnote">Elevacion: AWS Terrain Tiles (Mapzen Terrarium, datos abiertos). Recorte de ~8 km alrededor de la cima.</div>
                </>
            )}
        </div>
    );
}
