import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Arranca el servidor real, lee /health y lo apaga (un "reinicio"). */
async function bootAndHealth(dataDir, port) {
  const env = { PATH: process.env.PATH, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'test' };
  const child = spawn(process.execPath, ['src/index.js'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('el servidor no arranco')), 10000);
      child.stdout.on('data', (b) => {
        if (String(b).includes('server.listening')) {
          clearTimeout(t);
          resolve();
        }
      });
      child.on('exit', (code) => reject(new Error(`el servidor salio con ${code}`)));
    });
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return (await res.json()).storage;
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
  }
}

test('DATA_DIR se respeta y el registro sobrevive a reinicios', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-store-'));
  const repoData = path.join(repo, 'data');
  const repoDataExisted = fs.existsSync(repoData);

  const s1 = await bootAndHealth(dir, 4311);
  assert.equal(s1.dataDir, dir);
  assert.equal(s1.dbFile, path.join(dir, 'connector.db'));
  assert.ok(fs.existsSync(path.join(dir, 'connector.db')));
  assert.equal(s1.bootCount, 1);
  assert.equal(s1.ordersTotal, 0);

  // Una venta registrada entre arranques.
  execFileSync(
    process.execPath,
    ['--input-type=module', '-e', "const { orders } = await import('./src/db.js'); orders.claim('paris', 'P-1');"],
    { cwd: repo, env: { PATH: process.env.PATH, DATA_DIR: dir } }
  );

  const s2 = await bootAndHealth(dir, 4312);
  assert.equal(s2.createdAt, s1.createdAt, 'misma base: la fecha de creacion no cambia');
  assert.ok(s2.bootCount > s1.bootCount, 'el contador de arranques sube');
  assert.equal(s2.ordersTotal, 1, 'la venta sigue registrada');

  // Con otro DATA_DIR es otra base: asi se ve un disco que se borro.
  const otro = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-store-'));
  const s3 = await bootAndHealth(otro, 4313);
  assert.equal(s3.bootCount, 1);
  assert.equal(s3.ordersTotal, 0);

  assert.equal(fs.existsSync(repoData), repoDataExisted, 'no escribio en ./data');
});
