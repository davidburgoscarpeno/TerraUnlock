// v1.92: miniatura del track para las tarjetas de aventura
import { useEffect, useRef } from 'react';

export default function TrackThumb({ track }: { track: [number, number][] }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const cv = ref.current; if (!cv) return;
        const g = cv.getContext('2d'); if (!g) return;
        const W = cv.width, H = cv.height;
        g.clearRect(0, 0, W, H);
        let minLa = 90, maxLa = -90, minLo = 180, maxLo = -180;
        for (const [la, lo] of track) {
            if (la < minLa) minLa = la; if (la > maxLa) maxLa = la;
            if (lo < minLo) minLo = lo; if (lo > maxLo) maxLo = lo;
        }
        const cy = (minLa + maxLa) / 2, cx = (minLo + maxLo) / 2;
        const kx = Math.max(0.2, Math.cos(cy * Math.PI / 180));
        const pad = 12;
        const s = Math.min(
            (W - pad * 2) / Math.max(1e-9, (maxLo - minLo) * kx),
            (H - pad * 2) / Math.max(1e-9, maxLa - minLa)
        );
        const X = (lo: number) => W / 2 + (lo - cx) * kx * s;
        const Y = (la: number) => H / 2 - (la - cy) * s;
        const step = Math.max(1, Math.ceil(track.length / 400));
        g.strokeStyle = '#2dc8aa'; g.lineWidth = 3; g.lineJoin = 'round'; g.lineCap = 'round';
        g.beginPath();
        for (let i = 0; i < track.length; i += step) {
            const x = X(track[i][1]), y = Y(track[i][0]);
            if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        const [ela, elo] = track[track.length - 1];
        g.lineTo(X(elo), Y(ela));
        g.stroke();
        const [sla, slo] = track[0];
        g.fillStyle = '#7ee0c8'; g.beginPath(); g.arc(X(slo), Y(sla), 4, 0, 7); g.fill();
        g.fillStyle = '#f0b429'; g.beginPath(); g.arc(X(elo), Y(ela), 4, 0, 7); g.fill();
    }, [track]);
    return <canvas ref={ref} className="tu-advthumb" width={128} height={88} aria-hidden="true" />;
}
