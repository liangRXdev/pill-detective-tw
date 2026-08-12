/**
 * C7／C15 的 Node 端入口 — 真正的斷言在 `tests/fetch_images_probe.py`。
 *
 * 為什麼繞去 Python：那組驗收要**真的用 Pillow 解碼損毀的 WebP**、
 * 要**真的數出 HTTP 請求次數**。在 Node 端只能 mock 掉 requests 與 Pillow，
 * 而 mock 掉的正是待驗證的那一段——那種測試永遠是綠的。
 *
 * **缺 uv 直接紅，不 skip。** skip 掉的測試在 CI 摘要裡看起來像通過，
 * 而這一組守的是「零位元組被當成成功」這種會靜默寫出壞檔的失效模式。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 找 uv。**Windows 上 Git Bash 的 PATH 不含 `~/.local/bin`**，
 * 同一台機器在 PowerShell 找得到、在 Bash 找不到——
 * 只寫 `'uv'` 會讓這組驗收依「用哪個 shell 跑測試」而定生死。
 */
function resolveUv() {
  const candidates = [
    process.env.UV_BIN,
    'uv',
    path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv'),
    path.join(os.homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (c !== 'uv' && !fs.existsSync(c)) continue;
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch { /* 下一個候選 */ }
  }
  return null;
}

test('C7／C15 圖片管線（uv run tests/fetch_images_probe.py）', () => {
  const uv = resolveUv();
  assert.ok(uv, '找不到 uv。這組驗收需要真的用 Pillow 解碼與真的數 HTTP 請求次數，'
    + '不可 skip——請先安裝 uv 或設定 UV_BIN（規格 L9）。');
  let out = '';
  try {
    out = execFileSync(uv, ['run', 'tests/fetch_images_probe.py'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows 上被 spawn 的 Python 預設用 cp950，印中文會 UnicodeEncodeError
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
  } catch (e) {
    assert.fail(`圖片管線驗收失敗：\n${e.stdout ?? ''}\n${e.stderr ?? ''}`);
  }
  assert.match(out, /全部通過/);
});
