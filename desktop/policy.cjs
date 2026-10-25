"use strict";
const { ID } = require("./library.cjs");
const APP_URL = "deckcraft://app/index.html";
function validateIPC(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw Error("invalid_command");
  const fields = {
    status: ["type"],
    library: ["type"],
    pick: ["type", "deck"],
    load: ["type", "deck", "trackId"],
    play: ["type", "deck"],
    pause: ["type", "deck"],
    seek: ["type", "deck", "position"],
    level: ["type", "deck", "value"],
    crossfader: ["type", "value"],
    reconnect: ["type"],
  }[request.type];
  if (!fields || Object.keys(request).length !== fields.length || Object.keys(request).some((k) => !fields.includes(k)))
    throw Error("invalid_command");
  if (fields.includes("deck") && !["A", "B", "C", "D"].includes(request.deck)) throw Error("invalid_deck");
  if (fields.includes("trackId") && (typeof request.trackId !== "string" || !ID.test(request.trackId))) throw Error("invalid_track");
  if (fields.includes("value") && (!Number.isFinite(request.value) || request.value < 0 || request.value > 100))
    throw Error("invalid_value");
  if (fields.includes("position") && (!Number.isFinite(request.position) || request.position < 0 || request.position > 7200))
    throw Error("invalid_position");
  return request;
}
function authorize(event, window) {
  const w = window?.webContents,
    f = event.senderFrame;
  return (
    !!w &&
    !w.isDestroyed() &&
    event.sender === w &&
    f &&
    f.url === APP_URL &&
    w.getURL() === APP_URL &&
    f.routingId === w.mainFrame.routingId &&
    f.processId === w.mainFrame.processId
  );
}
module.exports = { APP_URL, validateIPC, authorize };
