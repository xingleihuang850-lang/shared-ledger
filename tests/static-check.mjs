import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(join(root, file), 'utf8');

for (const file of ['app.js', 'sw.js']) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${file} 语法检查失败\n${result.stderr}`);
}

JSON.parse(read('manifest.json'));
JSON.parse(read('package.json'));

const html = read('index.html');
const localAssets = [...html.matchAll(/(?:src|href)="(?!https?:|#)([^"?]+)(?:\?[^"\s]*)?"/g)]
  .map(match => match[1])
  .filter(asset => asset && !asset.startsWith('data:'));
for (const asset of localAssets) {
  assert.ok(existsSync(join(root, asset)), `index.html 引用了不存在的文件：${asset}`);
}

const sw = read('sw.js');
const precached = [...sw.matchAll(/'\.\/([^'?]+)(?:\?[^']*)?'/g)].map(match => match[1]);
for (const asset of precached) {
  if (!asset) continue;
  assert.ok(existsSync(join(root, asset)), `sw.js 预缓存了不存在的文件：${asset}`);
}

assert.match(read('app.js'), /const APP_VERSION = '1\.2\.0'/);
assert.match(read('app.js'), /const BACKUP_FORMAT_VERSION = 2/);
assert.match(html, /app\.js\?v=1\.2\.0/);
assert.match(sw, /ledger-v8-20260824/);
assert.doesNotMatch(html + read('README.md'), /agentos-app\.net/);

console.log('静态检查通过：JS、JSON、页面资源、离线缓存和版本号均有效。');
