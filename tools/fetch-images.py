#!/usr/bin/env python
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=10", "requests>=2.31"]
# ///
"""
圖片鏡像管線 — 規格 `.ai-review/plan.md` §6 步驟 ②、D10、D14

    uv run tools/fetch-images.py [--in data/appearance.json.staging]
                                 [--limit N] [--workers 8]
                                 [--verify-all] [--batch k/n]

刻意鏡像而非外連（D10）：官方原圖中位 1.5 MB、最大 18 MB，`?c=` 無縮圖參數，
且無 ETag／Last-Modified、`Cache-Control: private` —— 單頁 20 張約 68 MB，
行動優先的臨床現場工具不能這樣做。

失敗紀律（全有全無）：暫時性下載失敗**不得**用「把該張剔除」吸收——
那會讓圖片因網路問題無聲消失，而縮水後的數字會變成下次比較的新基線。
重試 3 次仍失敗即整批中止，manifest 不回寫。

**零位元組必須視為失敗**：來源對不存在的圖回 HTTP 200 + 0 bytes，不是 404。
只看 status code 會把空回應當成成功，寫出一個 0 byte 的檔案。

增量判定（D10）：一般模式重抓的條件為「檔案不存在 **或** sha256 缺漏／格式不合法」。
「新增」與「URL 變更」不在這裡判斷——`fetch-appearance.mjs` 的 `carryHashes()`
已把這兩種情形表現為「sha256 留 null」，於是在這裡自動落入待抓。

**一般模式偵測不到「同 URL 原地換圖」**：要判斷遠端內容是否改變，本質上必須先下載，
那就失去增量的意義。那一半交給季度的 `--verify-all`（D14），
且**分批執行**（`--batch k/n`）——全量約 22 GB，單批會撞 Actions 六小時上限。
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
IMG_DIR = ROOT / "data" / "img"
EXCEPTIONS = ROOT / "data" / "image-exceptions.json"

MAX_EDGE = 640
WEBP_QUALITY = 78
RETRIES = 3
TIMEOUT = 60
BUDGET_BYTES = 200 * 1024 * 1024          # D9，與 verify-data 同值
MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024     # D9 下載大小上限
UA = "pill-detective-tw/1.0 (+https://github.com/liangRXdev)"

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_print_lock = threading.Lock()


def is_sha256(v: object) -> bool:
    """
    與 `fetch-appearance.mjs` 的 `isSha256`、`verify-data.mjs` **同一條規則**。

    只判斷「有值」的話，截斷、大寫或寫成 "undefined" 的雜湊都算已完成，
    那一張可以**永久**避開一般排程，只有季度全驗碰得到。
    沒驗格式的欄位只證明「有東西」，不證明「是雜湊」。
    """
    return isinstance(v, str) and _SHA256_RE.match(v) is not None


def log(msg: str) -> None:
    with _print_lock:
        print(msg, flush=True)


def download(url: str) -> bytes:
    """下載原圖，重試 RETRIES 次。全部失敗則拋出。"""
    last: Exception | None = None
    for _ in range(RETRIES):
        try:
            r = requests.get(url, timeout=TIMEOUT, headers={"User-Agent": UA})
            if r.status_code != 200:
                raise RuntimeError(f"HTTP {r.status_code}")
            # 來源對不存在的圖回 200 + 0 bytes（實測）。只看 status 會靜默寫出空檔。
            if not r.content:
                raise RuntimeError("空回應（HTTP 200 但 0 bytes）")
            if len(r.content) > MAX_DOWNLOAD_BYTES:
                raise RuntimeError(f"回應 {len(r.content)} bytes 超出上限 {MAX_DOWNLOAD_BYTES}")
            return r.content
        except Exception as e:  # noqa: BLE001 — 任何失敗都要重試
            last = e
    raise RuntimeError(f"重試 {RETRIES} 次仍失敗：{last}")


def to_webp(raw: bytes) -> bytes:
    """轉 WebP，長邊上限 MAX_EDGE。解碼失敗會拋出。"""
    im = Image.open(io.BytesIO(raw))
    im.load()                      # 強制解碼，截斷檔會在此爆
    if max(im.size) > MAX_EDGE:
        im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    out = io.BytesIO()
    im.save(out, "WEBP", quality=WEBP_QUALITY, method=5)
    return out.getvalue()


def verify_asset(dest: Path) -> None:
    """
    對**落地後**的 WebP 做完整解碼。

    `to_webp()` 的 `im.load()` 驗的是**來源原圖**，證明不了寫出去的那份完好；
    而 `verify-data.mjs` 比對的是 sha256，證明位元組沒被改，同樣證明不了可解碼。
    這裡是「可解碼」這個宣稱唯一真正的證據來源。
    """
    with Image.open(dest) as im:
        im.load()


def needs_fetch(img: dict, verify_all: bool) -> bool:
    """
    D10 的重抓判定。抽成具名函式是為了能被測到——
    內嵌在 list comprehension 裡的話，反寫成 `if img.get("sha256")`
    或漏掉缺檔判斷都不會有任何東西轉紅。
    """
    if verify_all:
        return True
    if not (ROOT / "data" / img["file"]).exists():
        return True
    return not is_sha256(img.get("sha256"))


def process(img: dict, verify_all: bool) -> tuple[str, str | None, str | None]:
    """回傳 (file, sha256, error)。已存在且雜湊已知時跳過。"""
    dest = ROOT / "data" / img["file"]
    try:
        if dest.exists() and is_sha256(img.get("sha256")) and not verify_all:
            return img["file"], img["sha256"], None
        raw = download(img["src"])
        webp = to_webp(raw)
        digest = hashlib.sha256(webp).hexdigest()
        # 內容未變且檔案已在，不重寫（維持 git 冪等）。
        # 季度全驗走這條——重下載證明不了磁碟上那份沒壞，要真的解碼
        if dest.exists() and img.get("sha256") == digest:
            if verify_all:
                verify_asset(dest)
            return img["file"], digest, None
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(webp)
        verify_asset(dest)          # 新抓的每一張都驗，成本只有一次解碼
        return img["file"], digest, None
    except Exception as e:  # noqa: BLE001
        return img["file"], None, str(e)


def probe_exceptions() -> list[str]:
    """
    D14.3：季度重驗**仍須探測例外清單中的 URL**。

    若已恢復為可解碼圖片，產生**人工裁決項（警告，非中止）**——
    圖片恢復是好事，用中止懲罰它會讓人傾向乾脆不清理例外清單。
    在人工撤銷例外前，該圖維持 placeholder。
    """
    if not EXCEPTIONS.exists():
        return []
    items = json.loads(EXCEPTIONS.read_text(encoding="utf-8")).get("items", [])
    recovered = []
    for x in items:
        try:
            raw = download(x["src"])
            to_webp(raw)
        except Exception:  # noqa: BLE001 — 仍然壞著，這是預期狀態
            continue
        recovered.append(f"{x['id']} {x['src']}（判定於 {x.get('decided_at')}：{x.get('reason')}）")
    return recovered


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", default="data/appearance.json.staging")
    ap.add_argument("--limit", type=int, default=0, help="只處理前 N 張（開發用）")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--verify-all", action="store_true",
                    help="重抓全部並比對雜湊，偵測原地換圖（D14，每季一次）")
    ap.add_argument("--batch", default=None, metavar="k/n",
                    help="分批執行第 k 批（共 n 批）。全量約 22 GB，單批會撞 Actions 六小時上限")
    args = ap.parse_args()

    manifest = ROOT / args.inp
    if not manifest.exists():
        print(f"✖ 找不到 {manifest}，請先執行 fetch-appearance", file=sys.stderr)
        return 1

    payload = json.loads(manifest.read_text(encoding="utf-8"))
    all_imgs = [g for it in payload["items"] for g in it["imgs"]]

    if args.batch:
        k, n = (int(x) for x in args.batch.split("/"))
        if not (1 <= k <= n):
            print(f"✖ --batch {args.batch} 不合法（需 1 ≤ k ≤ n）", file=sys.stderr)
            return 1
        # 依 file 名稱穩定切片：同一批每次都是同一組，重跑才有意義
        all_imgs = [g for i, g in enumerate(sorted(all_imgs, key=lambda g: g["file"])) if i % n == k - 1]
        log(f"分批模式 {k}/{n}：本批 {len(all_imgs):,} 張")

    todo = [g for g in all_imgs if needs_fetch(g, args.verify_all)]
    if args.limit:
        todo = todo[: args.limit]
    log(f"圖片 {len(all_imgs):,} 張，需處理 {len(todo):,} 張（已完成 {len(all_imgs) - len(todo):,}）")

    recovered = probe_exceptions() if args.verify_all else []
    for r in recovered:
        log(f"  ⚠ 例外清單中的圖片已恢復，需人工撤銷例外：{r}")

    if not todo:
        log("無待處理項目")
        return 0

    IMG_DIR.mkdir(parents=True, exist_ok=True)
    results: dict[str, str] = {}
    failures: list[tuple[str, str]] = []
    done = 0

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for file, digest, err in pool.map(lambda g: process(g, args.verify_all), todo):
            done += 1
            if err:
                failures.append((file, err))
            else:
                results[file] = digest
            if done % 100 == 0 or done == len(todo):
                log(f"  {done:,}/{len(todo):,}  成功 {len(results):,}  失敗 {len(failures):,}")

    if failures:
        log(f"\n✖ {len(failures)} 張下載/轉檔失敗，整批中止（不得用剔除該張吸收）")
        for file, err in failures[:15]:
            log(f"    {file}  {err}")
        log("  manifest 未回寫。已下載的檔案保留，重跑可續傳。")
        log("  若確認某個官方 URL 是**永久**壞的，走 data/image-exceptions.json 的人工審核，")
        log("  **不要**讓管線自動加入例外——那會讓例外變成吸收網路失敗的旁路。")
        return 1

    # 容量檢查必須在回寫 manifest **之前**：
    # 先寫再檢查後回非零，等於「宣稱這批不發布」但 manifest 已經被改掉了，
    # 下一輪的基線因此是一個從未通過驗收的版本。
    total = sum(f.stat().st_size for f in IMG_DIR.glob("*.webp"))
    if total > BUDGET_BYTES:
        log(f"\n✖ 資產總量 {total / 1024 / 1024:.1f} MB 超出 "
            f"{BUDGET_BYTES / 1024 / 1024:.0f}MB 預算，需人工決策")
        log("  manifest 未回寫。")
        return 1

    by_file = {g["file"]: g for it in payload["items"] for g in it["imgs"]}
    for file, digest in results.items():
        by_file[file]["sha256"] = digest
    payload["meta"]["images_bytes"] = total
    manifest.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    filled = sum(1 for g in by_file.values() if is_sha256(g.get("sha256")))
    log(f"\n✓ 完成。資產 {len(list(IMG_DIR.glob('*.webp'))):,} 張 / {total / 1024 / 1024:.1f} MB，"
        f"manifest 已填雜湊 {filled:,}/{len(by_file):,}")
    if recovered:
        log(f"  ⚠ 另有 {len(recovered)} 筆例外待人工撤銷（見上）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
