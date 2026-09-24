/** FIT definition base-type bytes, including the endian flag where required. */
export declare enum FitBaseType {
    Enum = 0,
    Sint8 = 1,
    Uint8 = 2,
    String = 7,
    Uint8z = 10,
    Byte = 13,
    Sint16 = 131,
    Uint16 = 132,
    Sint32 = 133,
    Uint32 = 134,
    Float32 = 136,
    Float64 = 137,
    Uint16z = 139,
    Uint32z = 140,
    Sint64 = 142,
    Uint64 = 143,
    Uint64z = 144
}
export interface FitEncoderField {
    number: number;
    size: number;
    baseType: FitBaseType | number;
    value: number | bigint | Uint8Array;
}
export interface FitEncoderOptions {
    protocolVersion?: number;
    profileVersion?: number;
}
/**
 * A generic FIT binary encoder. Callers supply profile-specific field
 * definitions and already-scaled field values. Numeric arrays, strings, and
 * variable-length field values are supplied as raw `Uint8Array` values.
 */
export declare class FitEncoder {
    private readonly data;
    private readonly activeDefinitions;
    private readonly protocolVersion;
    private readonly profileVersion;
    constructor(options?: FitEncoderOptions);
    writeMessage(globalMessageNumber: number, fields: FitEncoderField[], localMessageNumber?: number): this;
    close(): Uint8Array;
    static string(value: string): Uint8Array;
    static toFitTimestamp(date: Date): number;
    static calculateCRC(bytes: ArrayLike<number>): number;
    private validateMessage;
    private validateField;
    private assertNumberInRange;
    private assertBigIntInRange;
    private getUnsignedMaximum;
    private getFieldDefinition;
    private writeDefinition;
    private writeFieldValue;
    private getBaseTypeSize;
    private isSupportedBaseType;
    private writeUInt8;
    private writeUInt16;
    private writeInt8;
    private writeInt16;
    private writeUInt32;
    private writeInt32;
    private writeUInt64;
    private writeInt64;
    private writeFloat32;
    private writeFloat64;
    private static assertIntegerInRange;
}
