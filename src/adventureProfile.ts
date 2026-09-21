// v1.12: calculo y pintado reutilizable del perfil de elevacion de una aventura.
import { sampleElevations } from './terrain';
import type { AdventureProfile } from './types';

function distM(a: [number, number], b: [number, number]) {
    const m = (a[0] + b[0]) / 2 * Math.PI / 180;
    return Math.hypot((a[1] - b[1]) * 111320 * Math.cos(m), (a[0] - b[0]) * 110540);
}

export async function computeProfile(track: [number, number][]): Promise<AdventureProfile> {
    const ele = await sampleElevations(track);
    const d: number[] = [0];
    for (let i = 1; i < track.length; i++) d.push(d[i - 1] + distM(track[i - 1], track[i]) / 1000);
    const sm: number[] = Array.from(ele).map((_, i) => {
        let s = 0, n = 0;
        for (let k = Math.max(0, i - 2); k <= Math.min(ele.length - 1, i + 2); k++) { s += ele[k]; n++; }
        return s / n;
    });
    let up = 0, down = 0;
    for (let i = 1; i < sm.length; i++) { const dd = sm[i] - sm[i - 1]; if (dd > 0) up += dd; else down -= dd; }
    let min = Infinity, max = -Infinity;
    for (const v of ele) { if (v < min) min = v; if (v > max) max = v; }
    return {
        d: d.map((v) => Math.round(v * 100) / 100),
        e: Array.from(ele).map((v) => Math.round(v)),
        up: Math.round(up), down: Math.round(down), min: Math.round(min), max: Math.round(max),
    };
}

// Pinta el perfil en la region (x, y, w, h) de cualquier contexto 2D.
export function drawProfile(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, p: AdventureProfile, axisFont = 14) {
    const dMax = p.d[p.d.length - 1] || 1;
    const eMin = Math.floor(p.min / 100) * 100;
    const eMax = Math.ceil(p.max / 100) * 100 || eMin + 100;
    g.font = '600 ' + axisFont + 'px -apple-system, Segoe UI, Roboto, sans-serif';
    const padL = Math.ceil(g.measureText(eMax + ' m').width) + 16, padR = 12, padT = 14, padB = Math.round(axisFont * 1.2) + 14;
    const iw = w - padL - padR, ih = h - padT - padB;
    const X = (d: number) => x + padL + d / dMax * iw;
    const Y = (e: number) => y + padT + (1 - (e - eMin) / Math.max(1, eMax - eMin)) * ih;
    g.fillStyle = '#0a0f16'; g.fillRect(x, y, w, h);
    g.textAlign = 'right';
    const span = eMax - eMin;
    const step = span > 1200 ? 500 : span > 500 ? 200 : span > 200 ? 100 : 50;
    for (let e = eMin; e <= eMax; e += step) {
        g.strokeStyle = 'rgba(90,110,130,0.22)';
        g.beginPath(); g.moveTo(x + padL, Y(e)); g.lineTo(x + w - padR, Y(e)); g.stroke();
        g.fillStyle = '#5c7080'; g.fillText(e + ' m', x + padL - 8, Y(e) + 5);
    }
    g.beginPath(); g.moveTo(X(0), Y(p.e[0]));
    for (let i = 1; i < p.e.length; i++) g.lineTo(X(p.d[i]), Y(p.e[i]));
    g.lineTo(X(dMax), y + padT + ih); g.lineTo(X(0), y + padT + ih); g.closePath();
    const grad = g.createLinearGradient(0, y + padT, 0, y + padT + ih);
    grad.addColorStop(0, 'rgba(45,200,170,0.45)'); grad.addColorStop(1, 'rgba(45,200,170,0.04)');
    g.fillStyle = grad; g.fill();
    g.beginPath(); g.moveTo(X(0), Y(p.e[0]));
    for (let i = 1; i < p.e.length; i++) g.lineTo(X(p.d[i]), Y(p.e[i]));
    g.strokeStyle = '#2dc8aa'; g.lineWidth = 2.5; g.stroke();
    g.textAlign = 'right'; g.fillStyle = '#5c7080';
    g.fillText(dMax.toFixed(1).replace('.', ',') + ' km', x + w - padR, y + h - 8);
    g.textAlign = 'left'; g.fillText('0', x + padL, y + h - 8);
}
