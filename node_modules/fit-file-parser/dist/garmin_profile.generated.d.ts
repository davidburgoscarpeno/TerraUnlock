import type { Message } from './fit.js';
export declare const GARMIN_PROFILE_VERSION: {
    readonly major: 21;
    readonly minor: 208;
    readonly patch: 0;
    readonly type: "Release";
};
export declare const GARMIN_MESSAGES: Record<number, Message>;
export declare const GARMIN_TYPES: Record<string, Record<number, string | number>>;
