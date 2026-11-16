# -*- coding: utf-8 -*-
"""本地保存服务：只监听本机，把登记数据写到 data/store.json。"""
import json
import os
import shutil
import threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
STORE = os.path.join(DATA_DIR, "store.json")
BACKUP = os.path.join(DATA_DIR, "store.bak.json")
BROKEN = os.path.join(DATA_DIR, "store.broken.json")
MAX_BYTES = 8 * 1024 * 1024
LOCK = threading.Lock()


def empty_doc():
    return {"v": 1, "people": [], "tasks": [], "currentTaskId": None, "_missing": True}


def usable(data):
    return isinstance(data, dict) and isinstance(data.get("people"), list) and isinstance(data.get("tasks"), list)


def meaningful(data):
    if not usable(data):
        return False
    if data.get("people"):
        return True
    for task in data.get("tasks") or []:
        if isinstance(task, dict) and (task.get("status") or task.get("notes")):
            return True
    return False


def read_store():
    if not os.path.isfile(STORE):
        return empty_doc()
    try:
        with open(STORE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return empty_doc()
    if not usable(data):
        return empty_doc()
    data.pop("_missing", None)
    data.pop("_corrupt", None)
    return data


def file_is_meaningful():
    if not os.path.isfile(STORE):
        return False
    try:
        with open(STORE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return False
    return meaningful(data)


def archive_if_unreadable():
    if not os.path.isfile(STORE):
        return
    try:
        with open(STORE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if usable(data):
            return
    except json.JSONDecodeError:
        pass
    except OSError:
        return
    os.makedirs(DATA_DIR, exist_ok=True)
    shutil.copy2(STORE, BROKEN)


def write_store(data):
    os.makedirs(DATA_DIR, exist_ok=True)
    data.pop("_missing", None)
    data.pop("_corrupt", None)
    data.pop("_idx", None)
    if os.path.isfile(STORE) and file_is_meaningful():
        shutil.copy2(STORE, BACKUP)
    else:
        archive_if_unreadable()
    tmp = STORE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, STORE)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        if args and str(args[0]).startswith("GET /api/data"):
            return
        super().log_message(fmt, *args)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, code, data):
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(raw)

    def _send_empty(self, code):
        self.send_response(code)
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()

    def do_OPTIONS(self):
        if urlparse(self.path).path != "/api/data":
            self.send_error(404)
            return
        self._send_empty(204)

    def do_GET(self):
        if urlparse(self.path).path == "/api/data":
            with LOCK:
                data = read_store()
            self._send_json(200, data)
            return
        return super().do_GET()

    def do_POST(self):
        self._write_api()

    def do_PUT(self):
        self._write_api()

    def _write_api(self):
        if urlparse(self.path).path != "/api/data":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400)
            return
        if length < 0 or length > MAX_BYTES:
            self.send_error(413)
            return
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_error(400, "不是合法的 JSON")
            return
        if not usable(data):
            self.send_error(400, "缺少 people 或 tasks")
            return
        with LOCK:
            if not meaningful(data) and file_is_meaningful():
                self._send_json(409, read_store())
                return
            write_store(data)
        self._send_empty(204)


def main():
    os.chdir(ROOT)
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
    except OSError as exc:
        print("端口 8765 已被占用。请先关闭另一个启动窗口。")
        print(exc)
        raise SystemExit(1)
    print("资料收集登记助手已启动： http://127.0.0.1:8765/")
    print("数据文件： " + STORE)
    print("请保持本窗口打开。关闭后页面将无法继续写入文件。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
