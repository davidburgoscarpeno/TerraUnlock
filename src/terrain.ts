// Elevacion del terreno para la ficha de cima.
// Fuente: tiles Terrarium (Mapzen) servidos en AWS Open Data (s3.amazonaws.com/elevation-tiles-prod),
// sin API key y con CORS abierto. Decodificacion: h = R*256 + G + B/256 - 32768.

export interface ElevGrid {
    n: number;          // lado de la rejilla (celdas)
    data: Float32Array; // elevacion en metros; fila 0 = norte
    min: number;
    max: number;
    mpp: number;        // metros por celda
}

const TZ = 13;            // zoom de los tiles de elevacion
const HALF_SPAN_M = 4200; // medio ancho del recorte alrededor de la cima
export const GRID_N = 300; // resolucion de trabajo

export function lonToPx(lon: number, z: number): number { return (lon + 180) / 360 * 256 * Math.pow(2, z); }
export function latToPx(lat: number, z: number): number {
    const s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * Math.pow(2, z);
}
export function decodeTerrarium(r: number, g: number, b: number): number { return r * 256 + g + b / 256 - 32768; }

// Intervalo "bonito" para curvas de nivel segun el desnivel del recorte.
export function niceLevels(min: number, max: number): { step: number; levels: number[] } {
    const amp = Math.max(1, max - min);
    const raw = amp / 9;
    let step = 1000;
    for (const o of [10, 20, 25, 50, 100, 200, 250, 500]) { if (o >= raw) { step = o; break; } }
    const levels: number[] = [];
    for (let v = Math.ceil(min / step) * step; v < max; v += step) levels.push(v);
    return { step, levels };
}

// Marching squares: segmentos [x1,y1,x2,y2,...] en coordenadas de celda (0..n-1).
export function contourSegments(data: Float32Array, n: number, level: number): number[] {
    const segs: number[] = [];
    for (let j = 0; j < n - 1; j++) {
        for (let i = 0; i < n - 1; i++) {
            const tl = data[j * n + i], tr = data[j * n + i + 1], br = data[(j + 1) * n + i + 1], bl = data[(j + 1) * n + i];
            let idx = 0;
            if (tl > level) idx |= 8;
            if (tr > level) idx |= 4;
            if (br > level) idx |= 2;
            if (bl > level) idx |= 1;
            if (idx === 0 || idx === 15) continue;
            const T: [number, number] = [i + (level - tl) / (tr - tl), j];
            const R: [number, number] = [i + 1, j + (level - tr) / (br - tr)];
            const B: [number, number] = [i + (level - bl) / (br - bl), j + 1];
            const L: [number, number] = [i, j + (level - tl) / (bl - tl)];
            const seg = (a: [number, number], c: [number, number]) => { segs.push(a[0], a[1], c[0], c[1]); };
            switch (idx) {
                case 1: seg(L, B); break;
                case 2: seg(B, R); break;
                case 3: seg(L, R); break;
                case 4: seg(T, R); break;
                case 5: seg(T, L); seg(B, R); break;
                case 6: seg(T, B); break;
                case 7: seg(T, L); break;
                case 8: seg(T, L); break;
                case 9: seg(T, B); break;
                case 10: seg(T, R); seg(L, B); break;
                case 11: seg(T, R); break;
                case 12: seg(L, R); break;
                case 13: seg(B, R); break;
                case 14: seg(L, B); break;
            }
        }
    }
    return segs;
}

// Sombreado de relieve (metodo de Horn, luz del noroeste).
export function hillshade(data: Float32Array, n: number, mpp: number): Uint8ClampedArray {
    const out = new Uint8ClampedArray(n * n);
    const az = 315 * Math.PI / 180, alt = 45 * Math.PI / 180;
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            const im = Math.max(0, i - 1), ip = Math.min(n - 1, i + 1);
            const jm = Math.max(0, j - 1), jp = Math.min(n - 1, j + 1);
            const dzdx = (data[j * n + ip] - data[j * n + im]) / ((ip - im) * mpp);
            const dzdy = (data[jp * n + i] - data[jm * n + i]) / ((jp - jm) * mpp);
            const slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
            const aspect = Math.atan2(dzdy, -dzdx);
            const s = Math.sin(alt) * Math.cos(slope) + Math.cos(alt) * Math.sin(slope) * Math.cos(az - aspect);
            out[j * n + i] = Math.max(0, Math.min(255, Math.round(s * 255)));
        }
    }
    return out;
}

// Rampa hipsometrica (t 0..1 entre min y max del recorte).
const RAMP: [number, [number, number, number]][] = [
    [0.0, [110, 140, 92]],
    [0.22, [158, 152, 98]],
    [0.45, [148, 118, 82]],
    [0.68, [126, 108, 96]],
    [0.86, [162, 162, 160]],
    [1.0, [248, 248, 246]],
];
export function hypoColor(t: number): [number, number, number] {
    const x = Math.max(0, Math.min(1, t));
    for (let k = 0; k < RAMP.length - 1; k++) {
        const [t0, c0] = RAMP[k], [t1, c1] = RAMP[k + 1];
        if (x <= t1) {
            const f = (x - t0) / (t1 - t0);
            return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
        }
    }
    return RAMP[RAMP.length - 1][1];
}

const gridCache = new Map<string, Promise<ElevGrid>>();

export function loadElevGrid(lat: number, lon: number): Promise<ElevGrid> {
    const key = lat.toFixed(3) + ',' + lon.toFixed(3);
    let p = gridCache.get(key);
    if (!p) {
        p = fetchGrid(lat, lon);
        gridCache.set(key, p);
        p.catch(() => gridCache.delete(key));
    }
    return p;
}

function loadTile(z: number, x: number, y: number): Promise<HTMLImageElement> {
    return new Promise((res, rej) => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('tile ' + z + '/' + x + '/' + y));
        im.src = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/' + z + '/' + x + '/' + y + '.png';
    });
}

async function fetchGrid(lat: number, lon: number): Promise<ElevGrid> {
    const mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, TZ);
    const halfPx = HALF_SPAN_M / mpp;
    const cx = lonToPx(lon, TZ), cy = latToPx(lat, TZ);
    const x0 = Math.floor((cx - halfPx) / 256), x1 = Math.floor((cx + halfPx) / 256);
    const y0 = Math.floor((cy - halfPx) / 256), y1 = Math.floor((cy + halfPx) / 256);
    const nx = x1 - x0 + 1, ny = y1 - y0 + 1;
    const stitch = document.createElement('canvas');
    stitch.width = nx * 256; stitch.height = ny * 256;
    const sctx = stitch.getContext('2d', { willReadFrequently: true });
    if (!sctx) throw new Error('canvas 2d no disponible');
    const jobs: Promise<void>[] = [];
    for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
            jobs.push(loadTile(TZ, tx, ty).then((img) => { sctx.drawImage(img, (tx - x0) * 256, (ty - y0) * 256); }));
        }
    }
    await Promise.all(jobs);
    const sx = cx - halfPx - x0 * 256, sy = cy - halfPx - y0 * 256, sw = halfPx * 2;
    const small = document.createElement('canvas');
    small.width = GRID_N; small.height = GRID_N;
    const c2 = small.getContext('2d', { willReadFrequently: true });
    if (!c2) throw new Error('canvas 2d no disponible');
    c2.drawImage(stitch, sx, sy, sw, sw, 0, 0, GRID_N, GRID_N);
    const px = c2.getImageData(0, 0, GRID_N, GRID_N).data;
    const data = new Float32Array(GRID_N * GRID_N);
    let min = Infinity, max = -Infinity;
    for (let k = 0; k < GRID_N * GRID_N; k++) {
        const e = decodeTerrarium(px[k * 4], px[k * 4 + 1], px[k * 4 + 2]);
        data[k] = e;
        if (e < min) min = e;
        if (e > max) max = e;
    }
    return { n: GRID_N, data, min, max, mpp: sw * mpp / GRID_N };
}

// Muestreo de altitud para una traza ([lat, lon][]): cada tile se pide una vez, interpolacion bilineal.
const tileGridCache = new Map<string, Promise<Float32Array>>();
function loadTileGrid(z: number, x: number, y: number): Promise<Float32Array> {
    const key = z + '/' + x + '/' + y;
    let p = tileGridCache.get(key);
    if (!p) {
        p = (async () => {
            const img = await loadTile(z, x, y);
            const cv = document.createElement('canvas');
            cv.width = 256; cv.height = 256;
            const cx = cv.getContext('2d', { willReadFrequently: true });
            if (!cx) throw new Error('canvas 2d no disponible');
            cx.drawImage(img, 0, 0);
            const px = cx.getImageData(0, 0, 256, 256).data;
            const g = new Float32Array(256 * 256);
            for (let k = 0; k < 256 * 256; k++) g[k] = decodeTerrarium(px[k * 4], px[k * 4 + 1], px[k * 4 + 2]);
            return g;
        })();
        tileGridCache.set(key, p);
        p.catch(() => tileGridCache.delete(key));
    }
    return p;
}

export async function sampleElevations(pts: [number, number][], z: number = TZ): Promise<Float32Array> {
    const need = new Map<string, [number, number]>();
    for (const [lat, lon] of pts) {
        const tx = Math.floor(lonToPx(lon, z) / 256), ty = Math.floor(latToPx(lat, z) / 256);
        need.set(tx + '/' + ty, [tx, ty]);
    }
    const grids = new Map<string, Float32Array>();
    await Promise.all([...need.entries()].map(async ([k, xy]) => { grids.set(k, await loadTileGrid(z, xy[0], xy[1])); }));
    const out = new Float32Array(pts.length);
    pts.forEach(([lat, lon], i) => {
        const gx = lonToPx(lon, z), gy = latToPx(lat, z);
        const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
        const g = grids.get(tx + '/' + ty);
        if (!g) { out[i] = 0; return; }
        const fx = gx - tx * 256, fy = gy - ty * 256;
        const x0 = Math.max(0, Math.min(255, Math.floor(fx))), y0 = Math.max(0, Math.min(255, Math.floor(fy)));
        const x1 = Math.min(255, x0 + 1), y1 = Math.min(255, y0 + 1);
        const dx = Math.max(0, Math.min(1, fx - x0)), dy = Math.max(0, Math.min(1, fy - y0));
        const a = g[y0 * 256 + x0], b = g[y0 * 256 + x1], c = g[y1 * 256 + x0], d = g[y1 * 256 + x1];
        out[i] = a * (1 - dx) * (1 - dy) + b * dx * (1 - dy) + c * (1 - dx) * dy + d * dx * dy;
    });
    return out;
}
