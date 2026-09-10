import { mkdir, mkdtemp, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function normalizeBasePath(value = "") {
  const path = value.trim();
  if (!path || path === "/") return "/";
  const segments = path.replace(/^\/+|\/+$/g, "").split("/");
  if (path.startsWith("//") || segments.some(part => !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(part)) || ["_headers", "_redirects"].includes(segments[0])) {
    throw new Error("BASE_PATH must be a URL path such as /extras/ (letters, numbers, dots, underscores and hyphens; no URL, query or traversal).");
  }
  return `/${segments.join("/")}/`;
}

// Keep the upload root fixed. Nest the already flattened game packages only
// after Vite has emptied and rebuilt that root, so changing paths leaves no stale files.
export async function nestStaticSite(outDir, base) {
  if (base === "/") return;
  const target = join(outDir, base.slice(1));
  const staging = await mkdtemp(`${outDir}-base-`);
  await rename(outDir, join(staging, "site"));
  await mkdir(dirname(target), { recursive: true });
  await rename(join(staging, "site"), target);
  await rmdir(staging);

  // Cloudflare reads this control file at the upload root, not the site subpath.
  const headers = join(target, "_headers");
  const source = await readFile(headers, "utf8");
  await rename(headers, join(outDir, "_headers"));
  await writeFile(join(outDir, "_headers"), source.replace(/^\/(.*)$/gm, (_, path) => base + path));
}
