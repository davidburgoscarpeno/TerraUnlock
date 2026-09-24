import type { PropertySignature, Statement, TypeNode } from 'typescript';
import type { Message, MessageObject } from './fit.js';
import ts from 'typescript';
type SnakeToCamelCase<S extends string> = S extends `${infer T}_${infer U}` ? `${T}${Capitalize<SnakeToCamelCase<U>>}` : S;
export declare function line(): ts.Node;
export declare function comment(contents: string): ts.Node[];
export declare function header(): ts.Node;
export declare function capitalize<T extends string>(s: T): string;
export declare function snakeToCamel<T extends string>(s: T): SnakeToCamelCase<Capitalize<T>>;
export declare function unicodeToChar(text: string): string;
export declare function generateProperty(name: string, type: TypeNode, optional?: boolean): PropertySignature;
export declare function generateArrayProperty(name: string, type: TypeNode, optional?: boolean): PropertySignature;
export declare function generateTypeFromField(def: MessageObject): TypeNode;
export declare function generateTypes(types: {
    [typeName: string]: Record<number, string | number>;
}): Statement[];
export declare function generateOptions(options: {
    [typeName: string]: Record<number, string | number>;
}): ts.Node[];
export declare function generateUtilities(): Statement[];
export declare function generateFitType(): Statement;
export declare function generateParsedMessages(messages: {
    [messageId: number]: Message;
}): Statement;
export declare function generateMessages(messages: {
    [messageId: number]: Message;
}): Statement[];
export declare function main(): string;
export {};
