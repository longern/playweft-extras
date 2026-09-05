import { resolve } from "node:path";
import { defineConfig } from "vite";
import { emitGamePackages } from "./build/vite/plugins/emit-game-packages.js";
import { preserveGameUrls } from "./build/vite/plugins/preserve-game-urls.js";

const games = ["light-trails"];
const input = { index: resolve(import.meta.dirname, "index.html") };
for (const game of games) {
  input[game] = resolve(import.meta.dirname, `games/${game}/index.html`);
  input[`${game}-help`] = resolve(import.meta.dirname, `games/${game}/help.html`);
}

export default defineConfig({
  plugins: [emitGamePackages({ games }), preserveGameUrls({ games })],
  server: { port: 9140, cors: true },
  build: { rollupOptions: { input } },
});
