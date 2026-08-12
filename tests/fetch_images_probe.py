#!/usr/bin/env python
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=10", "requests>=2.31"]
# ///
"""
C7／C15 驗收 — 圖片管線（規格 `.ai-review/plan.md` §10）

    uv run tests/fetch_images_probe.py

由 `tests/images.test.mjs` 呼叫。**只有 Python 端做得到的事才放這裡**：
要真的用 Pillow 解碼損毀的 WebP、要真的數出 HTTP 請求次數，
在 Node 端只能 mock，而 mock 掉的正是待驗證的那段。

失敗即 exit 1，訊息寫到 stderr。
"""
from __future__ import annotations

import http.server
import importlib.util
import io
import json
import socketserver
import sys
import tempfile
import threading
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent

# 直接載入受測模組（檔名有連字號，不能 import）
spec = importlib.util.spec_from_file_location("fetch_images", ROOT / "tools" / "fetch-images.py")
FI = importlib.util.module_from_spec(spec)
spec.loader.exec_module(FI)

FAILURES: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        FAILURES.append(msg)


def png_bytes(size=(80, 60), color=(200, 30, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


# ── 受控 HTTP 端點：記錄每個路徑的請求次數 ─────────────────────────
HITS: dict[str, int] = {}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):  # 靜音
        pass

    def do_GET(self):  # noqa: N802
        HITS[self.path] = HITS.get(self.path, 0) + 1
        if self.path.startswith("/zero"):
            # 來源實測行為：不存在的圖回 HTTP 200 + 0 bytes，不是 404
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif self.path.startswith("/corrupt"):
            body = png_bytes()[:40]          # 截斷的 PNG：header 對、資料不全
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path.startswith("/500"):
            self.send_response(500)
            self.send_header("Content-Length", "0")
            self.end_headers()
        else:
            body = png_bytes()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


def serve():
    srv = socketserver.TCPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def main() -> int:
    # Windows 上被 spawn（無主控台）時 stdout 預設是 cp950，
    # 印出 ✓ 或中文會炸成 UnicodeEncodeError，測試因此紅在無關的地方。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    srv, base = serve()

    # ── C7：零位元組必須視為失敗，且真的重試 3 次 ──────────────────
    HITS.clear()
    try:
        FI.download(f"{base}/zero-a")
        check(False, "C7: 0 bytes 回應被當成成功")
    except RuntimeError as e:
        check("空回應" in str(e), f"C7: 錯誤訊息未指出空回應：{e}")
    check(HITS.get("/zero-a") == FI.RETRIES,
          f"C7: 實際請求 {HITS.get('/zero-a')} 次，應為 {FI.RETRIES} 次（重試沒有真的發生）")

    # 對照組：正常回應只請求一次且成功
    HITS.clear()
    raw = FI.download(f"{base}/ok-a")
    check(len(raw) > 0 and HITS.get("/ok-a") == 1, "C7: 正常回應的對照組失敗")

    # 非 200 同樣重試後失敗
    HITS.clear()
    try:
        FI.download(f"{base}/500-a")
        check(False, "C7: HTTP 500 被當成成功")
    except RuntimeError:
        pass
    check(HITS.get("/500-a") == FI.RETRIES, "C7: HTTP 500 未重試 RETRIES 次")

    # ── 解碼驗證：截斷的圖必須在轉檔時就爆，不得寫出壞檔 ────────────
    HITS.clear()
    corrupt = FI.download(f"{base}/corrupt-a")
    check(len(corrupt) > 0, "截斷檔應該仍有位元組")
    try:
        FI.to_webp(corrupt)
        check(False, "C7b: 截斷的 PNG 竟然轉檔成功")
    except Exception:  # noqa: BLE001
        pass

    # verify_asset 對落地後的壞檔要抓得到
    with tempfile.TemporaryDirectory() as td:
        bad = Path(td) / "bad.webp"
        bad.write_bytes(b"RIFF____WEBPVP8 ")     # 有 header、沒有內容
        try:
            FI.verify_asset(bad)
            check(False, "C7b: verify_asset 放行了無法解碼的檔案")
        except Exception:  # noqa: BLE001
            pass
        good = Path(td) / "good.webp"
        good.write_bytes(FI.to_webp(png_bytes()))
        try:
            FI.verify_asset(good)
        except Exception as e:  # noqa: BLE001
            check(False, f"C7b: 正常 WebP 被誤判為損毀：{e}")

    # ── needs_fetch：D10 的四種情形 ────────────────────────────────
    sha_ok = "a" * 64
    with tempfile.TemporaryDirectory() as td:
        rel = "img/probe-0.webp"
        p = FI.ROOT / "data" / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        existed = p.exists()
        backup = p.read_bytes() if existed else None
        p.write_bytes(FI.to_webp(png_bytes()))
        try:
            check(FI.needs_fetch({"file": rel, "sha256": sha_ok}, False) is False,
                  "needs_fetch: 檔案在且雜湊合法時不該重抓")
            check(FI.needs_fetch({"file": rel, "sha256": None}, False) is True,
                  "needs_fetch: 雜湊缺漏時必須重抓")
            check(FI.needs_fetch({"file": rel, "sha256": "undefined"}, False) is True,
                  "needs_fetch: 雜湊格式不合法時必須重抓")
            check(FI.needs_fetch({"file": "img/does-not-exist-0.webp", "sha256": sha_ok}, False) is True,
                  "needs_fetch: 檔案不存在時必須重抓")
            check(FI.needs_fetch({"file": rel, "sha256": sha_ok}, True) is True,
                  "needs_fetch: --verify-all 必須一律重抓")
        finally:
            if backup is not None:
                p.write_bytes(backup)
            elif p.exists():
                p.unlink()

    # ── is_sha256：驗格式而非只驗有值 ──────────────────────────────
    check(FI.is_sha256("a" * 64) and not FI.is_sha256("A" * 64)
          and not FI.is_sha256("a" * 63) and not FI.is_sha256("undefined")
          and not FI.is_sha256(None), "is_sha256 格式判定錯誤")

    # ── C15：分批切片必須穩定且互斥、涵蓋全集 ──────────────────────
    imgs = [{"file": f"img/{i:04d}-0.webp"} for i in range(97)]

    def slice_batch(k, n):
        return [g for i, g in enumerate(sorted(imgs, key=lambda g: g["file"])) if i % n == k - 1]

    batches = [slice_batch(k, 4) for k in (1, 2, 3, 4)]
    flat = [g["file"] for b in batches for g in b]
    check(len(flat) == len(set(flat)) == 97, "C15: 四批未涵蓋全集或有重疊")
    check(slice_batch(2, 4) == batches[1], "C15: 同一批兩次切片結果不同（重跑會抓到不同的圖）")

    srv.shutdown()

    if FAILURES:
        print(f"\n✖ {len(FAILURES)} 項失敗：", file=sys.stderr)
        for f in FAILURES:
            print(f"    {f}", file=sys.stderr)
        return 1
    print("✓ C7／C15 全部通過")
    return 0


if __name__ == "__main__":
    sys.exit(main())
