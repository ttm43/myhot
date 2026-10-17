"""AIHOT 后台接口的最小客户端：登录、预览信源配置、创建信源。

密码从 MyHOT 根目录的 .env 读（ADMIN_PASSWORD），不打印。

    python scripts/aihot_admin.py preview configs/anthropic.json      # 逐条预览，打印前几条标题/链接/日期
    python scripts/aihot_admin.py create  configs/anthropic.json      # 预览通过的才创建
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AIHOT_ENV = ROOT.parent / ".env"
BASE = "http://localhost:3000"


def env_value(key: str) -> str:
    for line in AIHOT_ENV.read_text(encoding="utf-8").splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit(f"{AIHOT_ENV} 里没有 {key}")


class Admin:
    def __init__(self) -> None:
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar), _NoRedirect()
        )
        self.csrf = ""

    def login(self) -> None:
        data = urllib.parse.urlencode({"password": env_value("ADMIN_PASSWORD"), "return": "/admin"}).encode()
        req = urllib.request.Request(f"{BASE}/api/auth/password", data=data, method="POST",
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        try:
            self.opener.open(req, timeout=30)
        except urllib.error.HTTPError as exc:
            if exc.code != 303:
                raise
            if "wrong" in (exc.headers.get("Location") or "") or "unset" in (exc.headers.get("Location") or ""):
                raise SystemExit("登录失败：密码不对或未设置")
        me = self.get("/api/admin/me")
        self.csrf = me["csrf"]

    def get(self, path: str) -> dict:
        with self.opener.open(urllib.request.Request(f"{BASE}{path}"), timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def post(self, path: str, payload: dict, method: str = "POST") -> dict:
        req = urllib.request.Request(
            f"{BASE}{path}", data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), method=method,
            headers={"Content-Type": "application/json", "x-csrf-token": self.csrf},
        )
        try:
            with self.opener.open(req, timeout=180) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return {"_error": exc.code, "_body": exc.read().decode("utf-8", "ignore")[:600]}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def show_preview(result: dict, n: int = 5) -> int:
    if "_error" in result:
        print(f"   错误 {result['_error']}: {result['_body']}")
        return 0
    items = result.get("candidates") or result.get("items") or []
    print(f"   {len(items)} 条，耗时 {result.get('elapsedMs', '?')} ms")
    for it in items[:n]:
        print(f"   - {str(it.get('publishedAt') or '')[:10]} | {(it.get('title') or '')[:60]} | {it.get('url')}")
    return len(items)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["preview", "create"])
    parser.add_argument("file", help="JSON 文件：{\"sources\": [ {id,name,kind,config,tier,...} ]}")
    parser.add_argument("--only", default="")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    only = {s for s in args.only.split(",") if s}
    sources = json.loads(Path(args.file).read_text(encoding="utf-8"))["sources"]
    admin = Admin()
    admin.login()
    for s in sources:
        if only and s["id"] not in only:
            continue
        print(f"== {s['id']} {s['name']}")
        count = show_preview(admin.post("/api/admin/sources/preview", {"id": s["id"], "kind": s["kind"], "config": s["config"]}))
        if args.action == "create":
            if count == 0:
                print("   预览为空，不创建")
                continue
            created = admin.post("/api/admin/sources", s)
            print("   创建:", created if "_error" in created else created.get("id") or created)
    return 0


if __name__ == "__main__":
    sys.exit(main())
