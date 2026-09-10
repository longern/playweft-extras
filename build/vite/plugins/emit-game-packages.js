import { readFile } from "node:fs/promises";

/** Emit versioned manifests and authoritative rules beside each game entry. */
export function emitGamePackages({ games }) {
  let publicBase = "/";
  return {
    name: "emit-game-packages",
    configResolved(config) { publicBase = config.base; },
    async generateBundle() {
      for (const game of games) {
        const base = new URL(`../../../games/${game}/`, import.meta.url);
        let source = await readFile(new URL("playweft.json", base), "utf8");
        const manifest = JSON.parse(source);
        if (publicBase !== "/" && manifest.id?.startsWith("/") && !manifest.id.startsWith("//")) {
          manifest.id = publicBase + manifest.id.slice(1);
          source = JSON.stringify(manifest, null, 2) + "\n";
        }
        this.emitFile({ type: "asset", fileName: `games/${game}/playweft.json`, source });
        const entry = manifest.modes?.room?.server?.entry;
        if (entry) {
          const fileName = entry.replace(/^\.\//, "");
          if (!/^[a-zA-Z0-9._-]+\.lua$/.test(fileName)) throw new Error(`Invalid Lua entry for ${game}`);
          this.emitFile({
            type: "asset",
            fileName: `games/${game}/${fileName}`,
            source: await readFile(new URL(fileName, base), "utf8"),
          });
        }
      }
    },
  };
}
