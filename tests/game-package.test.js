import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, createServer, preview } from 'vite';
import { normalizeBasePath } from '../build/vite/base-path.js';

const root = resolve(import.meta.dirname, '..');

test('Vite emits independent game package at /light-trails/ with resolvable assets', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'playweft-extras-build-'));
  try {
    await build({ root, base: '/', logLevel: 'silent', build: { outDir, emptyOutDir: true } });
    const manifest = JSON.parse(await readFile(join(outDir, 'light-trails/playweft.json'), 'utf8'));
    assert.equal(manifest.id, '/light-trails/');
    assert.equal(manifest.modes.room.server.persistence, 'live');
    const list = JSON.parse(await readFile(join(outDir, 'featured-games.json'), 'utf8'));
    assert.deepEqual(list, [{ manifestUrl: './light-trails/playweft.json' }]);
    const base = new URL('https://games.example/light-trails/playweft.json');
    for (const entry of [manifest.start_url, manifest.help_url, manifest.icons[0].src, manifest.modes.room.server.entry]) {
      let path = new URL(entry, base).pathname;
      if (path.endsWith('/')) path += 'index.html';
      await access(join(outDir, path));
    }
    for (const page of ['index.html', 'light-trails/index.html']) {
      const html = await readFile(join(outDir, page), 'utf8');
      for (const [, url] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
        if (url.startsWith('http') || url.startsWith('data:')) continue;
        let path = new URL(url, `https://games.example/${page}`).pathname;
        if (path.endsWith('/')) path += 'index.html';
        await access(join(outDir, path));
      }
    }
    const rules = await readFile(join(root, 'games/light-trails/game.lua'), 'utf8');
    assert.equal(await readFile(join(outDir, 'light-trails/game.lua'), 'utf8'), rules);
  } finally { await rm(outDir, { recursive: true, force: true }); }
});

test('Vite serves stable game URLs, raw Lua and cross-origin manifests during development', async () => {
  const server = await createServer({ root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    for (const path of ['/light-trails/', '/light-trails/main.js', '/light-trails/styles.css', '/light-trails/help.html', '/light-trails.svg']) {
      assert.equal((await fetch(base + path)).status, 200, path);
    }
    const manifest = await fetch(base + '/light-trails/playweft.json', { headers: { Origin: 'https://play.longern.com' } });
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get('access-control-allow-origin'), '*');
    assert.equal((await manifest.json()).id, '/light-trails/');
    const lua = await fetch(base + '/light-trails/game.lua');
    assert.equal(await lua.text(), await readFile(join(root, 'games/light-trails/game.lua'), 'utf8'));
  } finally { await server.close(); }
});


test('BASE_PATH builds root or nested static sites and removes output from the previous path', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'playweft-extras-base-'));
  const saved = process.env.BASE_PATH;
  let previous;
  try {
    for (const value of [undefined, '/extras/', '/games/extras/', '']) {
      if (value === undefined) delete process.env.BASE_PATH;
      else process.env.BASE_PATH = value;
      await build({ root, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
      const base = normalizeBasePath(value), dir = join(outDir, base);
      if (previous) await assert.rejects(access(join(outDir, previous, 'index.html')));
      previous = base;
      const manifest = JSON.parse(await readFile(join(dir, 'light-trails/playweft.json'), 'utf8'));
      assert.equal(manifest.id, base + 'light-trails/');
      const manifestUrl = new URL(base + 'light-trails/playweft.json', 'https://games.example');
      for (const entry of [manifest.start_url, manifest.help_url, manifest.icons[0].src, manifest.modes.room.server.entry]) {
        let path = new URL(entry, manifestUrl).pathname;
        assert.ok(path.startsWith(base));
        if (path.endsWith('/')) path += 'index.html';
        await access(join(outDir, path));
      }
      for (const page of ['index.html', 'light-trails/index.html', 'light-trails/help.html']) {
        const html = await readFile(join(dir, page), 'utf8');
        for (const [, url] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
          if (/^(https?:|data:)/.test(url)) continue;
          let path = new URL(url, 'https://games.example' + base + page).pathname;
          assert.ok(path.startsWith(base), url);
          if (path.endsWith('/')) path += 'index.html';
          await access(join(outDir, path));
        }
      }
      const featured = JSON.parse(await readFile(join(dir, 'featured-games.json'), 'utf8'));
      assert.equal(new URL(featured[0].manifestUrl, 'https://games.example' + base).pathname, manifestUrl.pathname);
      const headers = await readFile(join(outDir, '_headers'), 'utf8');
      assert.ok(headers.includes(base + ':game/playweft.json'));
      assert.ok(headers.includes(base + 'featured-games.json'));
      assert.ok(headers.includes('Access-Control-Allow-Origin: *'));
      if (base !== '/') await assert.rejects(access(join(dir, '_headers')));
      const server = await preview({ root, base: '/', logLevel: 'silent', build: { outDir }, preview: { host:'127.0.0.1', port:0 } });
      try {
        const response = await fetch(`http://127.0.0.1:${server.httpServer.address().port}${base}light-trails/playweft.json`);
        assert.equal(response.status,200);
        assert.equal((await response.json()).id,manifest.id);
      } finally { await new Promise(resolve => server.httpServer.close(resolve)); }
    }
    assert.equal(JSON.parse(await readFile(join(root, 'games/light-trails/playweft.json'),'utf8')).id, '/light-trails/', 'source manifest remains portable');
  } finally {
    if (saved === undefined) delete process.env.BASE_PATH;
    else process.env.BASE_PATH = saved;
    await rm(outDir, { recursive: true, force: true });
  }
});

test('BASE_PATH normalizes simple prefixes and rejects unsafe or ambiguous locations', () => {
  for (const value of ['extras', '/extras', '/extras/']) assert.equal(normalizeBasePath(value), '/extras/');
  for (const value of ['../outside', '/a/../b', 'https://example.com/extras', '//example.com', '/a//b', '/a?b', '/a#b', '/%2e%2e/', '/_headers/']) {
    assert.throws(() => normalizeBasePath(value), /BASE_PATH/);
  }
});
