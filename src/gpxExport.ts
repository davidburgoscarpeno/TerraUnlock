// v1.13: exportar una aventura a GPX 1.1 (Strava, Garmin Connect, Wikiloc, Google Earth).
import type { Adventure, AdventureProfile } from './types';

function esc(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function adventureToGpx(adv: Adventure, prof: AdventureProfile | null, nombre: string): string {
    const track = adv.track || [];
    const t0 = new Date(adv.start).getTime();
    const t1 = Math.max(t0, new Date(adv.end).getTime());
    const name = 'TerraUnlock - ' + (nombre.trim() ? 'aventura de ' + nombre.trim() : 'aventura') + ' ' + new Date(adv.start).toLocaleDateString('es-ES');
    const lines: string[] = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push('<gpx version="1.1" creator="TerraUnlock" xmlns="http://www.topografix.com/GPX/1/1">');
    lines.push('  <metadata><name>' + esc(name) + '</name><time>' + new Date(adv.start).toISOString() + '</time></metadata>');
    lines.push('  <trk><name>' + esc(name) + '</name><type>hiking</type><trkseg>');
    const hasEle = !!prof && prof.e.length === track.length;
    track.forEach((pt, i) => {
        // El track no guarda timestamps por punto: se interpolan linealmente entre inicio y fin.
        const t = track.length > 1 ? t0 + (t1 - t0) * (i / (track.length - 1)) : t0;
        const ele = hasEle ? '<ele>' + prof!.e[i] + '</ele>' : '';
        lines.push('    <trkpt lat="' + pt[0].toFixed(6) + '" lon="' + pt[1].toFixed(6) + '">' + ele + '<time>' + new Date(t).toISOString() + '</time></trkpt>');
    });
    lines.push('  </trkseg></trk>');
    lines.push('</gpx>');
    return lines.join('\n');
}

export function gpxFilename(adv: Adventure): string {
    const d = new Date(adv.start);
    const p = (n: number) => String(n).padStart(2, '0');
    return 'terraunlock-aventura-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.gpx';
}
