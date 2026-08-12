/**
 * 測試用的最小 ZIP 產生器（store，不壓縮）。
 *
 * C 組要求「以注入 fixture 實跑」——只讀原始碼或用 mock 取代 ZIP reader，
 * 證明不了真的走到那道守門。這裡產生真的 ZIP 位元組餵給管線。
 *
 * 只支援 method 0（store）：管線兩種都吃，而 store 的產生器短到能一眼看完，
 * 測試工具本身出錯會讓所有 C 組結論失效。
 */
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** `YYYY-MM-DD` → DOS date word。傳 null 產生一個不合法的日期（用於測 mtime 缺席）。 */
export function dosDate(iso) {
  if (iso === null) return 0;   // 月/日皆為 0 → dosDateToISO 回 null
  const [y, m, d] = iso.split('-').map(Number);
  return ((y - 1980) << 9) | (m << 5) | d;
}

/**
 * @param entries [{ name, content: string|Buffer }]
 * @param opts    { date: 'YYYY-MM-DD' | null, deflate: boolean }
 */
export function makeZip(entries, opts = {}) {
  const { date = '2026-08-10', deflate = false } = opts;
  const dd = dosDate(date);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, 'utf8');
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);        // mod time
    lh.writeUInt16LE(dd, 12);       // mod date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(dd, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + data.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

/** 一列合法的來源資料。覆寫其中任何欄位即可造出各種 fixture。 */
export function srcRow(over = {}) {
  return {
    許可證字號: '衛署藥製字第000001號',
    中文品名: '測試錠',
    英文品名: 'TEST TABLET',
    形狀: '圓形',
    特殊劑型: '',
    顏色: '白',
    特殊氣味: '',
    刻痕: '無',
    外觀尺寸: '8',
    標註一: 'TS 1',
    標註二: null,
    外觀圖檔連結: 'https://mcp.fda.gov.tw/insert/shapeImg/00000000-0000-0000-0000-000000000001?c=o',
    ...over,
  };
}

/** 產生 n 列合法資料，id 與圖片 URL 皆唯一。 */
export function srcRows(n, over = () => ({})) {
  return Array.from({ length: n }, (_, i) => {
    const seq = String(i + 1).padStart(6, '0');
    return srcRow({
      許可證字號: `衛署藥製字第${seq}號`,
      外觀圖檔連結: `https://mcp.fda.gov.tw/insert/shapeImg/${seq}?c=o`,
      ...over(i),
    });
  });
}
