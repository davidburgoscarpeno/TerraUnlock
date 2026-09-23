// v1.43: grafico de ritmo por tramo de una aventura con timestamps (hermano del perfil de elevacion).
import { useEffect, useMemo, useRef } from 'react';
import { t } from './i18n';
import type { Adventure } from './types';

function distM(a: [number, number], b: [number, number]): number {
    const R = 6371000, dLa = (b[0] - a[0]) * Math.PI / 180, dLo = (b[1] - a[1]) * Math.PI / 180;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

type Series = { x: number[]; y: number[]; min: number; max: number; avg: number; totalKm: number };

// serie suavizada de ritmo (s/unidad) a lo largo de la distancia; sin outliers de pausas
function paceSeries(adv: Adventure, perMile: boolean): Series | null {
    if (!adv.track || !adv.times || adv.times.length !== adv.track.length || adv.track.length < 8) return null;
    const unit = perMile ? 1.609344 : 1;
    const d: number[] = [0];
    for (let i = 1; i < adv.track.length; i++) d.push(d[i - 1] + distM(adv.track[i - 1], adv.track[i]) / 1000);
    const totalKm = d[d.length - 1];
    if (totalKm < 0.3) return null;
    const segs: { at: number; pace: number }[] = [];
    for (let i = 1; i < d.length; i++) {
        const dd = d[i] - d[i - 1], dt = (adv.times[i] - adv.times[i - 1]) / 1000;
        if (dd <= 0 || dt <= 0) continue;
        const pace = dt / (dd / unit);
        if (pace >= 15) segs.push({ at: d[i], pace });
    }
    if (segs.length < 6) return null;
    const med = [...segs].sort((a, b) => a.pace - b.pace)[Math.floor(segs.length / 2)].pace;
    const ok = segs.filter((s) => s.pace <= med * 3); // pausas y saltos de GPS fuera
    if (ok.length < 6) return null;
    // 40 cubos por distancia, media por cubo y suavizado movil de 3
    const BINS = 40;
    const bins: { sum: number; n: number }[] = Array.from({ length: BINS }, () => ({ sum: 0, n: 0 }));
    for (const s of ok) {
        const bi = Math.min(BINS - 1, Math.floor(s.at / totalKm * BINS));
        bins[bi].sum += s.pace; bins[bi].n++;
    }
    const x: number[] = [], y: number[] = [];
    for (let i = 0; i < BINS; i++) if (bins[i].n) { x.push((i + 0.5) / BINS * totalKm); y.push(bins[i].sum / bins[i].n); }
    if (y.length < 4) return null;
    const ys: number[] = y.map((_, i) => {
        const lo = Math.max(0, i - 1), hi = Math.min(y.length - 1, i + 1);
        let s = 0; for (let j = lo; j <= hi; j++) s += y[j];
        return s / (hi - lo + 1);
    });
    const min = Math.min(...ys), max = Math.max(...ys);
    const totalSec = (adv.times[adv.times.length - 1] - adv.times[0]) / 1000;
    const avg = totalSec / (totalKm / unit);
    return { x, y: ys, min, max, avg, totalKm };
}

function fmtP(sec: number, perMile: boolean): string {
    const m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return m + ':' + String(s).padStart(2, '0') + '/' + (perMile ? 'mi' : 'km');
}

export default function PaceChart({ adv, imp }: { adv: Adventure; imp: boolean }) {
    const ref = useRef<HTMLCanvasElement | null>(null);
    const data = useMemo(() => paceSeries(adv, imp), [adv, imp]);
    useEffect(() => {
        const cv = ref.current;
        if (!cv || !data) return;
        const g = cv.getContext('2d');
        if (!g) return;
        const W = cv.width, H = cv.height, padL = 8, padR = 8, padT = 14, padB = 8;
        const iw = W - padL - padR, ih = H - padT - padB;
        g.clearRect(0, 0, W, H);
        const span = Math.max(data.max - data.min, 1);
        const px = (km: number) => padL + (km / data.totalKm) * iw;
        const py = (p: number) => padT + (1 - (p - data.min) / span) * ih; // rapido arriba
        // area bajo la curva
        g.beginPath();
        data.x.forEach((km, i) => { const X = px(km), Y = py(data.y[i]); if (i === 0) g.moveTo(X, Y); else g.lineTo(X, Y); });
        g.strokeStyle = '#2dc8aa'; g.lineWidth = 3; g.lineJoin = 'round'; g.stroke();
        g.lineTo(px(data.x[data.x.length - 1]), H - padB); g.lineTo(px(data.x[0]), H - padB); g.closePath();
        g.fillStyle = 'rgba(45,200,170,0.18)'; g.fill();
        // media
        g.setLineDash([6, 5]);
        g.beginPath(); g.moveTo(padL, py(data.avg)); g.lineTo(W - padR, py(data.avg));
        g.strokeStyle = 'rgba(230,205,110,0.7)'; g.lineWidth = 2; g.stroke();
        g.setLineDash([]);
        // extremos
        g.fillStyle = '#9fb0c0'; g.font = '600 20px system-ui, sans-serif';
        g.fillText(fmtP(data.min, imp), padL + 2, padT + 8);
        g.fillText(fmtP(data.max, imp), padL + 2, H - padB - 4);
        g.textAlign = 'right';
        g.fillText(fmtP(data.avg, imp), W - padR - 2, py(data.avg) - 6);
        g.textAlign = 'left';
    }, [data, imp]);
    if (!data) return null;
    return <div className="tu-elev">
        <canvas ref={ref} width={640} height={180} />
        <div className="tu-terrnote">{t('Ritmo por tramo: entre {fast} y {slow} (media {avg})', { fast: fmtP(data.min, imp), slow: fmtP(data.max, imp), avg: fmtP(data.avg, imp) })}</div>
    </div>;
}
