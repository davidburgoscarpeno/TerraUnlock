import type { FitOptions, MesgNum } from './fit_types.js';
export type MessageName = Exclude<MesgNum, number | 'definition'>;
export interface FieldDefinition {
    type: string | number;
    rawType?: string | number;
    fDefNo: number;
    size: number;
    array?: boolean;
    endianAbility: boolean;
    littleEndian: boolean;
    baseTypeNo: number;
    name: string;
    dataType: string;
    scale?: number | null;
    offset?: number;
    units?: string;
    requiresBoundedDataView?: boolean;
    developerDataIndex?: number;
    isDeveloperField?: boolean;
}
export interface MessageObject {
    field: string;
    type: string;
    baseType?: string;
    array?: boolean;
    scale: number | null;
    offset: number;
    units: string;
}
export interface Message {
    name: MessageName;
    [fieldId: number]: MessageObject;
}
export interface FitType {
    scConst: number;
    options: FitOptions;
    messages: Record<number, Message>;
    types: Record<string, Record<number, string | number>>;
}
/**
 * Garmin fields observed in the external FIT corpus but absent from the pinned
 * public SDK profile. These additions may not replace standard SDK fields.
 */
export declare const FIT_VENDOR_MESSAGE_EXTENSIONS: Record<number, Message>;
export declare const FIT_VENDOR_TYPE_EXTENSIONS: Record<string, Record<number, string>>;
export declare const FIT: FitType;
