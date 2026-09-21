// v1.11: grafico del perfil de elevacion de una aventura (datos: AWS Terrain Tiles / Terrarium).
import { useEffect, useRef, useState } from 'react';
import { sampleElevations } from './terrain';
import type { Adventure, AdventureProfile } from './types';

function distM(a: [number, number], b: [number, number]) {
    const m = (a[0] + b[0]) / 2 * Math.PI / 180;
    return Math.hypot((a[1] - b[1]) * 111320 * Math.cos(m), (a[0] - b[0]) * 110540);
}

function draw(cv: HTMLCanvasElement, p: AdventureProfile) {
    const g = cv.getContext('2d');
    if (!g) return;
    const W = cv.width, H = cv.height, padL = 52, padR = 12, padT = 14, padB = 30;
    const iw = W - padL - padR, ih = H - padT - padB;
    const dMax = p.d[p.d.length - 1] || 1;
    const eMin = Math.floor(p.min / 100) * 100;
    const eMax = Math.ceil(p.max / 100) * 100 || eMin + 100;
    const X = (d: number) => padL + d / dMax * iw;
    const Y = (e: number) => padT + (1 - (e - eMin) / Math.max(1, eMax - eMin)) * ih;
    g.fillStyle = '#0a0f16'; g.fillRect(0, 0, W, H);
    g.font = '600 14px -apple-system, Segoe UI, Roboto, sans-serif';
    g.textAlign = 'right';
    const span = eMax - eMin;
    const step = span > 1200 ? 500 : span > 500 ? 200 : span > 200 ? 100 : 50;
    for (let e = eMin; e <= eMax; e += step) {
        g.strokeStyle = 'rgba(90,110,130,0.22)';
        g.beginPath(); g.moveTo(padL, Y(e)); g.lineTo(W - padR, Y(e)); g.stroke();
        g.fillStyle = '#5c7080'; g.fillText(e + ' m', padL - 8, Y(e) + 5);
    }
    g.beginPath(); g.moveTo(X(0), Y(p.e[0]));
    for (let i = 1; i < p.e.length; i++) g.lineTo(X(p.d[i]), Y(p.e[i]));
    g.lineTo(X(dMax), padT + ih); g.lineTo(X(0), padT + ih); g.closePath();
    const grad = g.createLinearGradient(0, padT, 0, padT + ih);
    grad.addColorStop(0, 'rgba(45,200,170,0.45)'); grad.addColorStop(1, 'rgba(45,200,170,0.04)');
    g.fillStyle = grad; g.fill();
    g.beginPath(); g.moveTo(X(0), Y(p.e[0]));
    for (let i = 1; i < p.e.length; i++) g.lineTo(X(p.d[i]), Y(p.e[i]));
    g.strokeStyle = '#2dc8aa'; g.lineWidth = 2.5; g.stroke();
    g.textAlign = 'right'; g.fillStyle = '#5c7080';
    g.fillText(dMax.toFixed(1).replace('.', ',') + ' km', W - padR, H - 8);
    g.textAlign = 'left'; g.fillText('0', padL, H - 8);
}

export default function ElevChart({ adv, onProfile }: { adv: Adventure; onProfile: (start: string, prof: AdventureProfile | null) => void }) {
    const ref = useRef<HTMLCanvasElement | null>(null);
    const [state, setState] = useState<'loading' | 'ready' | 'none'>(adv.profile ? 'ready' : 'loading');
    useEffect(() => {
        let dead = false;
        if (adv.profile) { setState('ready'); return; }
        if (!adv.track || adv.track.length < 2 || adv.noProfile) { setState('none'); return; }
        setState('loading');
        (async () => {
            try {
                const track = adv.track as [number, number][];
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
                const prof: AdventureProfile = {
                    d: d.map((v) => Math.round(v * 100) / 100),
                    e: Array.from(ele).map((v) => Math.round(v)),
                    up: Math.round(up), down: Math.round(down), min: Math.round(min), max: Math.round(max),
                };
                if (!dead) { onProfile(adv.start, prof); setState('ready'); }
            } catch {
                if (!dead) { onProfile(adv.start, null); setState('none'); }
            }
        })();
        return () => { dead = true; };
    }, [adv, onProfile]);
    useEffect(() => {
        if (state === 'ready' && adv.profile && ref.current) draw(ref.current, adv.profile);
    }, [state, adv]);
    if (state === 'none') return <div className="tu-terrnote">Perfil de elevacion no disponible para esta aventura.</div>;
    return <div className="tu-elev">
        {state === 'loading' ? <div className="tu-terrnote">Calculando perfil de elevacion...</div> : null}
        <canvas ref={ref} width={640} height={240} style={{ display: state === 'ready' ? 'block' : 'none' }} />
        {state === 'ready' && adv.profile ? <div className="tu-terrnote">Subida acumulada +{adv.profile.up} m - Bajada -{adv.profile.down} m - Cotas {adv.profile.min}-{adv.profile.max} m</div> : null}
    </div>;
}
