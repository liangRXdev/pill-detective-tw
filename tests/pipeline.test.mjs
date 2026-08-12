/**
 * C 組驗收 — 管線 fail-closed（規格 `.ai-review/plan.md` §10 C1–C13）
 *
 * 每一條都以**注入 fixture 實跑 CLI**，不是讀原始碼、不是 mock 掉 ZIP reader。
 * 每一條都附「相鄰合法 fixture 會成功」的對照組——
 * 沒有對照組的話，「管線無條件失敗」也會讓整組 C 通過。
 *
 * 每一條都斷言**已發布的產物位元組與 mtime 完全未變**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeZip, srcRow, srcRows } from './_zip.mjs';
import {
  dosDateToISO, carryHashes, isSha256, assetKey, findAssetKeyCollisions,
  watchEmptyFields, checkVocab, readZipEntries, pickDataFile, metadataOnlyPayload,
} from '../tools/fetch-appearance.mjs';
import { verify } from '../tools/verify-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'tools/fetch-appearance.mjs');
const VERIFY = path.join(ROOT, 'tools/verify-data.mjs');

const LOCK = { color: ['白'], shape: ['圓形'], score_mark: ['無'] };

let tmpSeq = 0;
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pillscope-${process.pid}-${tmpSeq++}-`));
  const out = path.join(dir, 'appearance.json');
  const lock = path.join(dir, 'vocab.lock.json');
  fs.writeFileSync(lock, JSON.stringify(LOCK), 'utf8');
  return { dir, out, lock };
}

/** 跑 CLI，回傳 { code, stdout, stderr } —— 不丟例外，失敗是待驗證的結果 */
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/**
 * 資料列 → ZIP。與 `writeZipEntries` **刻意分成兩個函式**：
 * 原本用 `Array.isArray()` 判斷傳進來的是列還是 entries，而兩者都是陣列——
 * C1 因此把 entries 當成資料列包進 42_5.json，「0 個候選」是因為那些列缺欄位而不是
 * 因為 ZIP 裡沒有合格檔案。**測試通過了，但測到的不是它宣稱的那件事。**
 */
function writeZip(dir, rows, opts) {
  return writeZipEntries(dir, [{ name: '42_5.json', content: JSON.stringify(rows) }], opts);
}

function writeZipEntries(dir, entries, opts) {
  const p = path.join(dir, `src-${crypto.randomUUID()}.zip`);
  fs.writeFileSync(p, makeZip(entries, opts));
  return p;
}

/**
 * **已發布**產物的指紋：內容 sha256 ＋ mtime ＋ 檔案集合。
 * `.staging` 不算已發布（D12），故排除——否則「產生了候選版本」會被誤判為改動了正式版。
 */
function fingerprint(dir) {
  const files = fs.readdirSync(dir)
    .filter((f) => !f.endsWith('.zip') && !f.includes('.staging'))
    .sort();
  return files.map((f) => {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) return `${f}/`;
    return `${f}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}:${st.mtimeMs}`;
  }).join('|');
}

/** 先建立一個「已發布」的基線版本，再對它注入失敗 */
function publish(ws, rows) {
  const zip = writeZip(ws.dir, rows);
  const r = run(['--source', zip, '--out', ws.out, '--vocab-lock', ws.lock]);
  assert.equal(r.code, 0, `建立基線失敗：${r.stderr}`);
  fs.renameSync(`${ws.out}.staging`, ws.out);
  return zip;
}

// ── 純函式 ──────────────────────────────────────────────────────────

test('C0a dosDateToISO 拒絕曆法上不存在的日期（寫假值比缺欄位更糟）', () => {
  const enc = (y, m, d) => ((y - 1980) << 9) | (m << 5) | d;
  assert.equal(dosDateToISO(enc(2026, 8, 10)), '2026-08-10');
  assert.equal(dosDateToISO(enc(2026, 2, 31)), null);
  assert.equal(dosDateToISO(enc(2026, 4, 31)), null);
  assert.equal(dosDateToISO(enc(2025, 2, 29)), null);
  assert.equal(dosDateToISO(enc(2024, 2, 29)), '2024-02-29');
  assert.equal(dosDateToISO(enc(2026, 13, 1)), null);
  assert.equal(dosDateToISO(0), null);
});

test('C0b isSha256 驗格式而非只驗有值', () => {
  assert.equal(isSha256('a'.repeat(64)), true);
  assert.equal(isSha256('A'.repeat(64)), false, '大寫應判為不合法');
  assert.equal(isSha256('a'.repeat(63)), false);
  assert.equal(isSha256('undefined'), false);
  assert.equal(isSha256(null), false);
});

// ── C1／C2 schema 辨識 ──────────────────────────────────────────────

test('C1 ZIP 內 0 個符合 schema 的資料檔 → 中止、已發布產物完全未變、staging 未產生', () => {
  const ws = workspace();
  publish(ws, srcRows(5100));
  const before = fingerprint(ws.dir);

  // 對照組：相鄰的合法 fixture 會成功 —— 證明是這道守門攔的
  const okZip = writeZip(ws.dir, srcRows(5100));
  assert.equal(run(['--source', okZip, '--out', ws.out, '--vocab-lock', ws.lock]).code, 0);
  fs.unlinkSync(`${ws.out}.staging`);

  const badZip = writeZipEntries(ws.dir, [
    { name: 'readme.txt', content: 'hello' },
    { name: 'other.json', content: JSON.stringify([{ 無關欄位: 1 }]) },
  ]);
  const r = run(['--source', badZip, '--out', ws.out, '--vocab-lock', ws.lock]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /0 個候選/);
  assert.equal(fingerprint(ws.dir), before, '已發布產物被改動');
  assert.equal(fs.existsSync(`${ws.out}.staging`), false, 'staging 殘留');
});

test('C2 ZIP 內 2 個符合 schema 的資料檔 → 中止並列出兩個檔名（不得取第一個）', () => {
  const ws = workspace();
  publish(ws, srcRows(5100));
  const before = fingerprint(ws.dir);

  const zip = writeZipEntries(ws.dir, [
    { name: '42_5.json', content: JSON.stringify(srcRows(5100)) },
    { name: '42_6.json', content: JSON.stringify(srcRows(5100)) },
  ]);
  const r = run(['--source', zip, '--out', ws.out, '--vocab-lock', ws.lock]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /2 個符合 schema/);
  assert.match(r.stderr, /42_5\.json/);
  assert.match(r.stderr, /42_6\.json/, '錯誤訊息未列出第二個候選');
  assert.equal(fingerprint(ws.dir), before);
});

// ── C3 詞彙快照 ─────────────────────────────────────────────────────

test('C3 詞彙快照：新增值／消失值／拼字變更皆中止，未變動則成功', () => {
  const ws = workspace();
  const base = srcRows(5100);

  // 對照組：未變動 → 成功
  assert.equal(run(['--source', writeZip(ws.dir, base), '--out', ws.out, '--vocab-lock', ws.lock]).code, 0);
  fs.unlinkSync(`${ws.out}.staging`);

  const cases = [
    ['新增值', base.map((r, i) => (i === 0 ? { ...r, 顏色: '螢光綠' } : r)), /螢光綠/],
    ['拼字變更', base.map((r) => ({ ...r, 形狀: '圓型' })), /圓型/],
    ['值消失', base.map((r) => ({ ...r, 刻痕: '' })), /刻痕|score_mark/],
  ];
  for (const [label, rows, re] of cases) {
    const r = run(['--source', writeZip(ws.dir, rows), '--out', ws.out, '--vocab-lock', ws.lock]);
    assert.notEqual(r.code, 0, `C3 ${label}: 應中止`);
    assert.match(r.stderr, re, `C3 ${label}: 錯誤訊息未指出差異值`);
    assert.equal(fs.existsSync(`${ws.out}.staging`), false, `C3 ${label}: staging 殘留`);
  }
});

test('C3b checkVocab 同時偵測新增與消失（純函式）', () => {
  const rows = [srcRow({ 顏色: '白' }), srcRow({ 許可證字號: 'X2', 顏色: '黑' })];
  const { errs } = checkVocab(rows, { color: ['白', '紅'], shape: ['圓形'], score_mark: ['無'] });
  assert.equal(errs.length, 2);
  assert.ok(errs.some((e) => e.includes('黑')), '未偵測到新增值');
  assert.ok(errs.some((e) => e.includes('紅')), '未偵測到消失值');
});

// ── C4 下限守門與變動守門分開測 ─────────────────────────────────────

test('C4 筆數下限：4999 中止、5000 通過此道（與變動幅度守門彼此獨立）', () => {
  // **刻意在無前版的情況下測**：有前版時 4,999 會先被 ±3% 攔下，
  // 那樣就永遠測不到 <5000 這道，而 5,000 本身也不小於 5,000。
  const ws = workspace();
  const r1 = run(['--source', writeZip(ws.dir, srcRows(4999)), '--out', ws.out, '--vocab-lock', ws.lock]);
  assert.notEqual(r1.code, 0);
  assert.match(r1.stderr, /4999 筆，低於下限 5000/);

  const ws2 = workspace();
  const r2 = run(['--source', writeZip(ws2.dir, srcRows(5000)), '--out', ws2.out, '--vocab-lock', ws2.lock]);
  assert.equal(r2.code, 0, `5000 筆應通過下限守門：${r2.stderr}`);
});

test('C4b 變動幅度守門：>3% 中止、--allow-any-delta 可放行，且與下限守門獨立', () => {
  const ws = workspace();
  publish(ws, srcRows(6000));
  const before = fingerprint(ws.dir);

  const shrunk = writeZip(ws.dir, srcRows(5500));   // -8.3%，且 5500 仍高於下限
  const r = run(['--source', shrunk, '--out', ws.out, '--vocab-lock', ws.lock]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /變動幅度超出門檻/);
  assert.equal(fingerprint(ws.dir), before);

  const r2 = run(['--source', shrunk, '--out', ws.out, '--vocab-lock', ws.lock, '--allow-any-delta']);
  assert.equal(r2.code, 0, '人工放行後應可通過');
  assert.equal(fingerprint(ws.dir), before, '放行只產生 staging，不得改動已發布版本');
});

// ── C5 id 唯一 ──────────────────────────────────────────────────────

test('C5 許可證字號重複 → 中止並指出該 id 與次數（其他資料保持合法、總筆數不變）', () => {
  const ws = workspace();
  publish(ws, srcRows(5100));
  const before = fingerprint(ws.dir);

  const rows = srcRows(5100);
  rows[10] = { ...rows[10], 許可證字號: rows[9]['許可證字號'] };   // 只動 id，總筆數不變
  const r = run(['--source', writeZip(ws.dir, rows), '--out', ws.out, '--vocab-lock', ws.lock]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /許可證字號重複/);
  assert.match(r.stderr, new RegExp(`${rows[9]['許可證字號']} × 2`));
  assert.equal(fingerprint(ws.dir), before);
});

test('C5b 空的許可證字號 → 中止', () => {
  const ws = workspace();
  const rows = srcRows(5100);
  rows[3] = { ...rows[3], 許可證字號: '  ' };
  const r = run(['--source', writeZip(ws.dir, rows), '--out', ws.out, '--vocab-lock', ws.lock]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /空的許可證字號/);
});

// ── C6 資產鍵碰撞 ───────────────────────────────────────────────────

test('C6 資產鍵碰撞偵測（以可注入的 keyFn 實跑碰撞路徑）', () => {
  // 真實 assetKey 是 sha1 前 64 bits，測試無法在合理時間內構造碰撞。
  // 若只用真 keyFn，這道守門的失敗路徑永遠跑不到，寫了等於沒寫。
  // 因此注入一個刻意會碰撞的 keyFn，另用下一條斷言釘死 main() 用的是真的 assetKey。
  const ids = ['衛署藥製字第000001號', '衛署藥製字第000002號', '衛部藥輸字第000003號'];
  const collide = (id) => id.slice(0, 3);            // 前三字相同者必碰撞
  const hits = findAssetKeyCollisions(ids, collide);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].slice(0, 2), [ids[0], ids[1]]);

  // 真 keyFn 對同一組 id 不得碰撞（否則上面的注入等於沒有隔離變因）
  assert.deepEqual(findAssetKeyCollisions(ids, assetKey), []);
  // 同一個 id 出現兩次一定碰撞——證明偵測邏輯本身有效
  assert.equal(findAssetKeyCollisions([ids[0], ids[0]], assetKey).length, 1);
});

test('C6b assetKey 是 sha1(id) 的前 16 個 hex，且不同 id 不共用命名空間', () => {
  const id = '衛署藥製字第000001號';
  const want = crypto.createHash('sha1').update(id, 'utf8').digest('hex').slice(0, 16);
  assert.equal(assetKey(id), want);
  assert.match(assetKey(id), /^[0-9a-f]{16}$/);
  assert.notEqual(assetKey('內衛成製字第000075號'), assetKey('衛署藥製字第000075號'),
    '去中文或只留數字會讓這兩個碰撞——實測來源有 27 組這種情形');
});

// ── C8 D8 警告 ──────────────────────────────────────────────────────

test('C8 特殊劑型由全空轉為有值 → 警告但不中止；全空時不得有警告', () => {
  const ws = workspace();
  const rows = srcRows(5100);
  rows[7] = { ...rows[7], 特殊劑型: '腸溶錠' };
  const r = run(['--source', writeZip(ws.dir, rows), '--out', ws.out, '--vocab-lock', ws.lock]);
  assert.equal(r.code, 0, 'D8 是警告不是中止');
  assert.match(r.stdout, /D8 警告/);
  assert.match(r.stdout, /特殊劑型/);
  assert.match(r.stdout, /1 筆/);
  assert.match(r.stdout, new RegExp(rows[7]['許可證字號']), '警告未含代表 id');
  assert.match(r.stdout, /腸溶錠/, '警告未含代表值');
  const staged = JSON.parse(fs.readFileSync(`${ws.out}.staging`, 'utf8'));
  assert.equal(staged.meta.warnings.length, 1);

  // 反向對照：全空時不得有警告
  const ws2 = workspace();
  const r2 = run(['--source', writeZip(ws2.dir, srcRows(5100)), '--out', ws2.out, '--vocab-lock', ws2.lock]);
  assert.equal(r2.code, 0);
  assert.doesNotMatch(r2.stdout, /D8 警告/);
  assert.equal(JSON.parse(fs.readFileSync(`${ws2.out}.staging`, 'utf8')).meta.warnings, undefined);
});

test('C8b watchEmptyFields 純函式：兩個欄位各自獨立偵測', () => {
  assert.deepEqual(watchEmptyFields([srcRow()]), []);
  const w = watchEmptyFields([srcRow({ 特殊氣味: '薄荷味' }), srcRow({ 許可證字號: 'X2' })]);
  assert.equal(w.length, 1);
  assert.match(w[0], /特殊氣味/);
  assert.match(w[0], /薄荷味/);
});

// ── C9 冪等 ─────────────────────────────────────────────────────────

test('C9 冪等：首建正確 → 二次執行位元組相同 → 改來源必須產生預期差異', () => {
  const ws = workspace();
  const rows = srcRows(5100);
  const zip = writeZip(ws.dir, rows);

  // (a) 從無產物完成首建，並驗證內容正確——沒有這步，no-op 管線也會通過 (b)
  assert.equal(run(['--source', zip, '--out', ws.out, '--vocab-lock', ws.lock]).code, 0);
  const first = JSON.parse(fs.readFileSync(`${ws.out}.staging`, 'utf8'));
  assert.equal(first.items.length, 5100);
  assert.equal(first.meta.source_rows, 5100);
  assert.equal(first.meta.source_version, '2026-08-10');
  assert.equal(first.items[0].id, rows[0]['許可證字號']);
  assert.deepEqual(first.items[0].color, ['白']);
  assert.equal(first.items[0].imgs.length, 1);

  // (b) 第二次執行位元組完全相同（meta 不得含執行時間）
  const bytes1 = fs.readFileSync(`${ws.out}.staging`);
  assert.equal(run(['--source', zip, '--out', ws.out, '--vocab-lock', ws.lock]).code, 0);
  assert.ok(bytes1.equals(fs.readFileSync(`${ws.out}.staging`)), 'C9: 來源未變卻產生 diff');

  // (c) 改一個來源欄位必須產生預期的差異
  const changed = rows.map((r, i) => (i === 0 ? { ...r, 標註一: 'ZZ 9' } : r));
  assert.equal(run(['--source', writeZip(ws.dir, changed), '--out', ws.out, '--vocab-lock', ws.lock]).code, 0);
  const third = JSON.parse(fs.readFileSync(`${ws.out}.staging`, 'utf8'));
  assert.equal(third.items[0].mark1, 'ZZ 9', 'C9: 改了來源卻沒反映到產物');
  assert.notEqual(third.meta.content_hash, first.meta.content_hash);
});

// ── C10 發布原子性 ──────────────────────────────────────────────────

test('C10 verify 階段失敗 → 已發布的 appearance.json 位元組未變，且不得切換', () => {
  const ws = workspace();
  const zip = publish(ws, srcRows(5100));
  const published = fs.readFileSync(ws.out);
  const before = fingerprint(ws.dir);

  // 產生一個 staging，然後讓它驗不過（sha256 未填）
  assert.equal(run(['--source', zip, '--out', ws.out, '--vocab-lock', ws.lock]).code, 0);
  const v = (() => {
    try {
      execFileSync(process.execPath, [VERIFY, '--source', zip, '--in', `${ws.out}.staging`, '--skip-content'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return 0;
    } catch (e) { return e.status; }
  })();
  assert.notEqual(v, 0, 'sha256 未填的 staging 不該通過驗證');

  // --publish 必須拒絕切換
  const p = run(['--out', ws.out, '--publish']);
  assert.notEqual(p.code, 0);
  assert.match(p.stderr, /未完成/);
  assert.ok(published.equals(fs.readFileSync(ws.out)), 'C10: 已發布版本被改動');
  fs.unlinkSync(`${ws.out}.staging`);
  assert.equal(fingerprint(ws.dir), before);
});

test('C10b --publish 在沒有 staging 時中止', () => {
  const ws = workspace();
  publish(ws, srcRows(5100));
  const before = fingerprint(ws.dir);
  const r = run(['--out', ws.out, '--publish']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /沒有可發布的候選版本/);
  assert.equal(fingerprint(ws.dir), before);
});

test('C10c metadata-only 可先發布搜尋資料，但不放寬完整圖片守門', () => {
  const ws = workspace();
  const zip = writeZip(ws.dir, srcRows(5100));
  assert.equal(run(['--source', zip, '--out', ws.out, '--vocab-lock', ws.lock]).code, 0);

  const stagedPath = `${ws.out}.staging`;
  const staged = JSON.parse(fs.readFileSync(stagedPath, 'utf8'));
  staged.items[0].imgs[0].sha256 = 'a'.repeat(64);
  staged.items[0].imgs[0].src_bytes = 1234;
  fs.writeFileSync(stagedPath, JSON.stringify(staged), 'utf8');

  const r = run(['--out', ws.out, '--publish-metadata-only']);
  assert.equal(r.code, 0, r.stderr);
  const published = JSON.parse(fs.readFileSync(ws.out, 'utf8'));
  assert.equal(published.meta.images_complete, false);
  assert.equal(published.meta.images_bytes, 0);
  assert.ok(published.items.flatMap((it) => it.imgs).every((g) => g.sha256 === null));
  assert.ok(published.items.flatMap((it) => it.imgs).every((g) => !('src_bytes' in g)));
  assert.ok(fs.existsSync(stagedPath), 'metadata-only 發布不得消耗完整圖片候選版本');

  const before = fs.readFileSync(ws.out);
  const full = run(['--out', ws.out, '--publish']);
  assert.notEqual(full.code, 0, '完整發布仍必須拒絕缺圖版本');
  assert.ok(before.equals(fs.readFileSync(ws.out)), '完整發布失敗不得改動 metadata-only 正式版');
});

// ── C11 增量判定 ────────────────────────────────────────────────────

test('C11 carryHashes 四個子案例：全未變 0、URL 變更、檔案缺、雜湊不合法', () => {
  const sha = 'a'.repeat(64);
  const prev = [{
    id: 'A',
    imgs: [
      { file: 'img/k-0.webp', src: 'u0', sha256: sha, src_bytes: 111 },
      { file: 'img/k-1.webp', src: 'u1', sha256: sha, src_bytes: 222 },
    ],
  }];
  const mk = (srcs) => [{ id: 'A', imgs: srcs.map((s, n) => ({ file: `img/k-${n}.webp`, src: s, sha256: null, src_bytes: null })) }];

  // 全未變 → 兩張都沿用，待抓 0
  const same = mk(['u0', 'u1']);
  assert.equal(carryHashes(same, prev), 2);
  assert.equal(same[0].imgs.filter((g) => !isSha256(g.sha256)).length, 0, '待抓數量應為 0');
  // src_bytes 與 sha256 是同一次下載的產物，必須一起沿用——
  // 只沿用其中一個會讓 D14 的 HEAD 掃描拿 null 去比對而全部誤判為「已變更」
  assert.deepEqual(same[0].imgs.map((g) => g.src_bytes), [111, 222], 'src_bytes 未一起沿用');

  // 一張 URL 變更 → 只有那張要重抓
  const changed = mk(['u0', 'u1-new']);
  assert.equal(carryHashes(changed, prev), 1);
  assert.equal(changed[0].imgs[1].sha256, null, 'URL 變了卻沿用舊雜湊——新圖永遠抓不進來');

  // 前版雜湊格式不合法 → 不沿用
  const badPrev = [{ id: 'A', imgs: [{ file: 'img/k-0.webp', src: 'u0', sha256: 'undefined', src_bytes: 111 }] }];
  const fresh = mk(['u0']);
  assert.equal(carryHashes(fresh, badPrev), 0);

  // 前版沒有這筆 id → 不沿用
  assert.equal(carryHashes(mk(['u0']), []), 0);
});

test('C11c --resume：首建跨批次時從進度 manifest 讀前版，而不是從未發布的 appearance.json', () => {
  const ws = workspace();
  const rows = srcRows(5100);
  const zip = writeZip(ws.dir, rows);

  // 第一批：無進度檔 → 全部待抓
  const r1 = run(['--source', zip, '--out', ws.out, '--vocab-lock', ws.lock,
    '--resume', path.join(ws.dir, 'progress.json')]);
  assert.equal(r1.code, 0);
  assert.match(r1.stdout, /沿用雜湊 0 \/ 5,100/);

  // 模擬第一批抓完 3 張後把進度落地
  const staged = JSON.parse(fs.readFileSync(`${ws.out}.staging`, 'utf8'));
  for (const it of staged.items.slice(0, 3)) {
    for (const g of it.imgs) { g.sha256 = 'a'.repeat(64); g.src_bytes = 1000; }
  }
  fs.writeFileSync(path.join(ws.dir, 'progress.json'), JSON.stringify(staged), 'utf8');

  // 第二批：必須沿用那 3 張，而不是重抓全部
  const r2 = run(['--source', zip, '--out', ws.out, '--vocab-lock', ws.lock,
    '--resume', path.join(ws.dir, 'progress.json')]);
  assert.equal(r2.code, 0);
  assert.match(r2.stdout, /沿用雜湊 3 \/ 5,100/, 'C11c: 進度沒被沿用——首建會永遠跑不完');
  assert.match(r2.stdout, /首建續傳/);

  // 對照組：不給 --resume 就回到讀已發布版本（此處不存在）→ 全部待抓
  const r3 = run(['--source', zip, '--out', ws.out, '--vocab-lock', ws.lock]);
  assert.match(r3.stdout, /沿用雜湊 0 \/ 5,100/, 'C11c: --resume 影響到了預設行為');
});

test('C11b 首建時沒有前版，全部落入待抓（不得寫死 null 以外的值）', () => {
  const ws = workspace();
  const r = run(['--source', writeZip(ws.dir, srcRows(5100)), '--out', ws.out, '--vocab-lock', ws.lock]);
  assert.match(r.stdout, /沿用雜湊 0 \/ 5,100/);
  assert.match(r.stdout, /待抓 5,100/);
});

// ── C12 provenance 三重斷言 ─────────────────────────────────────────

test('C12 provenance：key 正確但 src 來自相鄰記錄時必須被抓到', () => {
  const rows = srcRows(3);
  const payload = {
    meta: { schema: 1, count: 3, source_rows: 3, vocab: { color: ['白'], shape: ['圓形'], score_mark: ['無'] } },
    items: rows.map((r) => ({
      id: r['許可證字號'],
      imgs: [{ file: `img/${assetKey(r['許可證字號'])}-0.webp`, src: r['外觀圖檔連結'], sha256: 'a'.repeat(64), src_bytes: 1024 }],
    })),
  };
  // 對照組：完全正確時只該有 search.js 常數與精簡 fixture 詞彙不符的錯（用完整常數比對會噪音）
  const clean = verify(payload, rows, { imgDir: null, skipContent: true })
    .filter((e) => !e.startsWith('search.js 的'));
  assert.deepEqual(clean, [], `對照組應無其他錯誤：${clean.join(' / ')}`);

  // 注入：第 0 筆的 key 正確，但下載的是第 1 筆的 src
  const bad = JSON.parse(JSON.stringify(payload));
  bad.items[0].imgs[0].src = rows[1]['外觀圖檔連結'];
  const errs = verify(bad, rows, { imgDir: null, skipContent: true }).filter((e) => !e.startsWith('search.js 的'));
  assert.equal(errs.length, 1);
  assert.match(errs[0], /imgs 來源不符/);
  // 只驗檔名的話這筆會全過——這正是 v1.1 那個過強宣稱的破口
  assert.equal(bad.items[0].imgs[0].file, `img/${assetKey(rows[0]['許可證字號'])}-0.webp`);
});

test('C12b provenance：檔案實算 sha256 與 manifest 不符時必須被抓到', () => {
  const ws = workspace();
  const rows = srcRows(1);
  const imgDir = path.join(ws.dir, 'img');
  fs.mkdirSync(imgDir);
  const content = Buffer.from('fake webp bytes');
  const real = crypto.createHash('sha256').update(content).digest('hex');
  const file = `img/${assetKey(rows[0]['許可證字號'])}-0.webp`;
  fs.writeFileSync(path.join(imgDir, path.basename(file)), content);

  const mk = (sha) => ({
    meta: { schema: 1, count: 1, source_rows: 1, vocab: { color: ['白'], shape: ['圓形'], score_mark: ['無'] } },
    items: [{ id: rows[0]['許可證字號'], imgs: [{ file, src: rows[0]['外觀圖檔連結'], sha256: sha, src_bytes: content.length }] }],
  });
  const clean = (p) => verify(p, rows, { imgDir }).filter((e) => !e.startsWith('search.js 的'));
  assert.deepEqual(clean(mk(real)), [], '實算相符時不該報錯');
  const errs = clean(mk('b'.repeat(64)));
  assert.equal(errs.length, 1);
  assert.match(errs[0], /檔案內容與 manifest 不符/);

  // 檔案不存在也要抓到
  fs.unlinkSync(path.join(imgDir, path.basename(file)));
  assert.match(clean(mk(real))[0], /檔案不存在/);
});

test('C12c verify 在缺 --source 時拒絕執行（只驗檔名等於沒驗 provenance）', () => {
  let code = 0;
  try {
    execFileSync(process.execPath, [VERIFY, '--in', path.join(ROOT, 'data/appearance.json')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { code = e.status; }
  assert.equal(code, 2);
});

// ── C13 例外清單 ────────────────────────────────────────────────────

test('C13 例外清單以 id+src 為鍵：精確命中才排除，同筆其餘有效圖仍保留', () => {
  const two = 'https://mcp.fda.gov.tw/a?c=o;;;https://mcp.fda.gov.tw/b?c=o';
  const rows = [srcRow({ 外觀圖檔連結: two })];
  const id = rows[0]['許可證字號'];
  const mk = (imgs) => ({
    meta: { schema: 1, count: 1, source_rows: 1, vocab: { color: ['白'], shape: ['圓形'], score_mark: ['無'] } },
    items: [{ id, imgs }],
  });
  const g = (n, src) => ({ file: `img/${assetKey(id)}-${n}.webp`, src, sha256: 'a'.repeat(64), src_bytes: 1024 });
  const clean = (p, ex) => verify(p, rows, { imgDir: null, skipContent: true, exceptions: ex })
    .filter((e) => !e.startsWith('search.js 的'));

  const ex = [{ id, src: 'https://mcp.fda.gov.tw/a?c=o', decided_at: '2026-08-12', reason: '官方連結永久回 0 bytes' }];
  // 例外命中：只排除那一張，另一張仍須保留且序號從 0 重編
  assert.deepEqual(clean(mk([g(0, 'https://mcp.fda.gov.tw/b?c=o')]), ex), []);
  // 整筆清空 → 應報錯（不得因一張壞圖遮掉同筆其餘有效圖）
  assert.match(clean(mk([]), ex)[0], /imgs 來源不符/);
  // 沒有例外時，少一張就是錯
  assert.match(clean(mk([g(0, 'https://mcp.fda.gov.tw/b?c=o')]), [])[0], /imgs 來源不符/);
});

test('C13b 例外的 id 或 src 對不上來源 → 報陳舊例外；缺欄位 → 報缺欄位', () => {
  const rows = [srcRow()];
  const id = rows[0]['許可證字號'];
  const payload = {
    meta: { schema: 1, count: 1, source_rows: 1, vocab: { color: ['白'], shape: ['圓形'], score_mark: ['無'] } },
    items: [{ id, imgs: [{ file: `img/${assetKey(id)}-0.webp`, src: rows[0]['外觀圖檔連結'], sha256: 'a'.repeat(64), src_bytes: 1024 }] }],
  };
  const clean = (ex) => verify(payload, rows, { imgDir: null, skipContent: true, exceptions: ex })
    .filter((e) => !e.startsWith('search.js 的'));

  assert.match(clean([{ id: '不存在的字號', src: 'x', decided_at: '2026-08-12', reason: 'r' }])[0], /陳舊例外/);
  assert.match(clean([{ id, src: 'https://不在來源', decided_at: '2026-08-12', reason: 'r' }])[0], /陳舊例外/);
  assert.ok(clean([{ id, src: rows[0]['外觀圖檔連結'], decided_at: '', reason: '' }])
    .some((e) => /缺欄位/.test(e)));
});

// ── verify 的其他不變量 ─────────────────────────────────────────────

test('C-extra verify 抓得到 count 不符、id 重複、缺 id、來源與產物集合不一致', () => {
  const rows = srcRows(2);
  const base = () => ({
    meta: { schema: 1, count: 2, source_rows: 2, vocab: { color: ['白'], shape: ['圓形'], score_mark: ['無'] } },
    items: rows.map((r) => ({
      id: r['許可證字號'],
      imgs: [{ file: `img/${assetKey(r['許可證字號'])}-0.webp`, src: r['外觀圖檔連結'], sha256: 'a'.repeat(64), src_bytes: 1024 }],
    })),
  });
  const clean = (p) => verify(p, rows, { imgDir: null, skipContent: true }).filter((e) => !e.startsWith('search.js 的'));
  assert.deepEqual(clean(base()), []);

  const badCount = base(); badCount.meta.count = 3;
  assert.match(clean(badCount)[0], /meta\.count 3 與實際筆數 2 不符/);

  const dupId = base(); dupId.items[1].id = dupId.items[0].id;
  assert.ok(clean(dupId).some((e) => /id 重複/.test(e)));

  const noId = base(); delete noId.items[0].id;
  assert.ok(clean(noId).some((e) => /缺 id/.test(e)));

  const badSchema = base(); badSchema.meta.schema = 2;
  assert.match(clean(badSchema)[0], /meta\.schema 應為 1/);
});

// ── ZIP 讀取器本身 ──────────────────────────────────────────────────

test('C-zip 讀取器：store 與 deflate 都能讀，截斷的 ZIP 會被擋下', () => {
  const rows = srcRows(2);
  for (const deflate of [false, true]) {
    const buf = makeZip([{ name: '42_5.json', content: JSON.stringify(rows) }], { deflate });
    const picked = pickDataFile(readZipEntries(buf));
    assert.equal(picked.rows.length, 2, `deflate=${deflate}`);
    assert.equal(picked.mtime, '2026-08-10');
  }
  const truncated = makeZip([{ name: '42_5.json', content: JSON.stringify(rows) }]).subarray(0, 40);
  assert.throws(() => readZipEntries(truncated), /End of Central Directory/);
});
