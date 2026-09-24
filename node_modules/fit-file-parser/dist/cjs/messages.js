"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFitMessage = getFitMessage;
exports.getFitMessageBaseType = getFitMessageBaseType;
const fit_js_1 = require("./fit.js");
function getFieldObject(fieldNum, messageNum) {
    const message = fit_js_1.FIT.messages[messageNum];
    if (!message) {
        return {};
    }
    return message[fieldNum] || {};
}
function getMessageName(messageNum) {
    const message = fit_js_1.FIT.messages[messageNum];
    return message ? message.name : '';
}
function getFitMessage(messageNum) {
    return {
        name: getMessageName(messageNum),
        getAttributes: (fieldNum) => getFieldObject(fieldNum, messageNum),
    };
}
// TODO
function getFitMessageBaseType(inp) {
    return inp;
}
