"use strict";
// Separate native entry for the portable preview; no installation or production state.
const { app } = require("electron");
const path = require("node:path");
const { startDesktop } = require("./main.cjs");
const { release } = require("../preview.json");
if (typeof release !== "string" || !/^[a-zA-Z0-9._+-]{1,100}$/.test(release)) throw Error("Invalid preview release");
async function startPreview() {
  const pending = startDesktop({ userData: path.join(app.getPath("appData"), "deck-craft-preview", release) });
  app.setName("Deck Craft Preview");
  app.setAppUserModelId("org.deckcraft.preview");
  app.setDesktopName("deck-craft-preview.desktop");
  const desktop = await pending;
  if (desktop) {
    desktop.window.on("page-title-updated", event => event.preventDefault());
    desktop.window.setTitle("Deck Craft Preview · " + release);
  }
  return desktop;
}
if (require.main === module) startPreview().catch(() => {
  console.error("Deck Craft Preview could not start. Check desktop dependencies and audio output.");
  app.quit(); process.exitCode = 1;
});
module.exports = { startPreview };
