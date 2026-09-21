import type { Peak } from './data/peaks_es';

export interface AdventureProfile { d: number[]; e: number[]; up: number; down: number; min: number; max: number; }
export interface Adventure { start: string; end: string; km: number; points: number; countries: string[]; ccaa: string[]; prov: string[]; peaks: string[]; track?: [number, number][]; times?: number[]; name?: string; profile?: AdventureProfile; noProfile?: boolean; }
export type { Peak };
