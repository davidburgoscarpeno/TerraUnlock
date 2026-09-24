import type { ParsedLap, ParsedSession } from './fit_types.js';
export declare function mapDataIntoLap(inputLaps: ParsedLap[], lapKey: 'records' | 'lengths', data: any[]): ParsedLap[];
export declare function mapDataIntoSession(inputSessions: ParsedSession[], laps: ParsedLap[]): ParsedSession[];
