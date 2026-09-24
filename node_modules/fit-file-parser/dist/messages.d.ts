import type { MessageName, MessageObject } from './fit.js';
export declare function getFitMessage(messageNum: number): {
    name: MessageName | '';
    getAttributes: (fieldNum: number) => MessageObject;
};
export declare function getFitMessageBaseType(inp: any): any;
