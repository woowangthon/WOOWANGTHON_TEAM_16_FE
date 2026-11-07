"""녹화(학습 데이터)를 하면서 같은 신호를 서버로도 보내 화면에서 실시간으로 본다.

watchmate-be의 `tools/collector.py session`을 그대로 실행하고, 녹화 도구가 받은 줄을 옆에서 서버로도 보낸다.
백엔드 파일은 바꾸지 않는다. 게이트웨이 USB 포트는 녹화 도구 하나만 연다(동시에 두 프로그램이 열 수 없기 때문).

실행(C:\\wm\\watchmate-be 폴더, .venv를 켠 PowerShell):
  $env:WATCHMATE_GATEWAY="COM7"
  python ..\\watchmate-fe\\scripts\\record_live.py --plan docs/plans/third_plan.csv --day 2026-11-07d `
      --out ..\\data\\sessions\\2026-11-07d --node RX-301=gw --node RX-302=gw --node RX-COR=gw `
      --countdown 20 --yes --notes "3차 측정"

  - session 옵션은 그대로 쓴다. 여기서만 쓰는 옵션: --api(기본 http://127.0.0.1:8000), --no-live(서버 없이 녹화만).
  - 서버 로그인: 환경 변수 WATCHMATE_USER·WATCHMATE_PASSWORD, 없으면 watchmate-be/.env의 DEMO_USERNAME·DEMO_PASSWORD,
    그것도 없으면 서버 기본값(demo). 실패하면 비밀번호를 물어본다(화면에 안 보임).
  - 수신기 토큰은 서버에서 새로 받아 이 프로그램 안에서만 쓴다(화면·파일에 남기지 않는다).
  - 서버가 잠깐 응답하지 않아도 녹화는 멈추지 않는다. 밀린 것은 최근 것부터 다시 보낸다.
  - 지금 장면을 http://127.0.0.1:8765/rec/scene 으로 알려 준다. 화면(npm run dev)이 이걸 읽어
    장면이 바뀔 때마다 구역마다 실제 상태(비어 있음·서 있음·앉아 있음·누워 있음)를 저절로 바꾸고 기록한다.
"""

from __future__ import annotations

import argparse
import getpass
import http.server as http_server
import importlib.util
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve()
BE = Path(os.environ.get("WATCHMATE_BE") or HERE.parents[2] / "watchmate-be")
SITE_FLOOR = "S4-1동 2층"
MAX_BACKLOG = 20000  # 서버가 멈췄을 때 노드마다 쌓아 둘 줄 수(약 4분). 넘으면 오래된 것부터 버린다
BATCH = 500  # 한 번에 보내는 프레임 수. 크면 서버가 바쁠 때 한 요청이 오래 걸려 계속 밀린다
POST_TIMEOUT = 30.0  # 보정 직후 서버가 기준선을 계산하는 동안(수십 초) 기다린다
REC_PORT = 8765


class RecState:
    """화면에 알려 줄 지금 장면. 녹화 도구의 장면 시작·녹화 시작·장면 끝에서 바뀐다."""

    def __init__(self, plan: list[dict], day: str):
        self.lock = threading.Lock()
        self.plan = plan
        self.names = [p["scene"] for p in plan]
        self.data = {"running": True, "day": day, "index": -1, "total": len(plan), "scene": None,
                     "description": "", "labels": {}, "phase": "idle", "phase_started": time.time(),
                     "phase_seconds": 0.0, "next": None}

    def update(self, **kw) -> None:
        with self.lock:
            self.data.update(kw)
            i = self.data["index"]
            nxt = self.plan[i + 1] if 0 <= i < len(self.plan) - 1 else None
            self.data["next"] = None if nxt is None else {"scene": nxt["scene"], "description": nxt["description"]}

    def snapshot(self) -> dict:
        with self.lock:
            return dict(self.data, now=time.time())


def serve_rec(state: RecState) -> None:
    class Handler(http_server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.path.split("?")[0] not in ("/rec/scene", "/scene"):
                self.send_error(404)
                return
            body = json.dumps(state.snapshot(), ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):  # 녹화 화면을 어지럽히지 않는다
            pass

    try:
        srv = http_server.ThreadingHTTPServer(("127.0.0.1", REC_PORT), Handler)
    except OSError as exc:
        say(f"  ! 화면 연동 포트 {REC_PORT}를 열지 못했어요({exc}). 녹화는 그대로 하고, 실제 상태는 화면에서 손으로 입력하세요.")
        return
    threading.Thread(target=srv.serve_forever, daemon=True, name="rec-state").start()


def post_frames(api: str, token: str, frames: list[dict], restarted: bool) -> dict:
    payload: dict = {"frames": frames, "source": "live"}
    if restarted:
        payload["restarted"] = True
    req = urllib.request.Request(api.rstrip("/") + "/api/ingest/csi", data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "X-Node-Token": token})
    with urllib.request.urlopen(req, timeout=POST_TIMEOUT) as resp:
        return json.loads(resp.read())


def say(text: str = "") -> None:
    print(text, flush=True)


def load_collector():
    path = BE / "tools" / "collector.py"
    if not path.exists():
        sys.exit(f"수집기 파일을 찾지 못했어요: {path}\nWATCHMATE_BE 환경 변수로 watchmate-be 폴더를 알려 주세요.")
    spec = importlib.util.spec_from_file_location("wm_collector", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["wm_collector"] = mod
    spec.loader.exec_module(mod)
    return mod


def http(method: str, url: str, token: str | None = None, body: dict | None = None, timeout: float = 15):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read()
    return json.loads(raw) if raw else None


def read_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def login(api: str) -> str:
    env = read_env_file(BE / ".env")
    user = os.environ.get("WATCHMATE_USER") or env.get("DEMO_USERNAME") or "demo"
    password = os.environ.get("WATCHMATE_PASSWORD") or env.get("DEMO_PASSWORD") or "demo1234"
    for attempt in range(2):
        try:
            return http("POST", f"{api}/api/auth/login", body={"username": user, "password": password})["token"]
        except urllib.error.HTTPError as exc:
            if exc.code != 401 or attempt or not sys.stdin.isatty():
                raise
            password = getpass.getpass(f"  서버 로그인 비밀번호({user})를 입력하세요(화면에 안 보여요): ")
    raise RuntimeError("로그인하지 못했어요.")


def receiver_tokens(api: str, names: list[str]) -> tuple[str, dict[str, str]]:
    """화면 2단계에서 등록한 실험 공간을 찾아, 녹화할 수신기의 토큰을 새로 받는다."""
    tok = login(api)
    buildings = http("GET", f"{api}/api/buildings", tok)
    site = next((b for b in buildings if b.get("floor_label") == SITE_FLOOR and not b.get("is_demo")), None)
    if site is None:
        sys.exit("  ✗ 서버에 실험 공간이 없어요. 화면 '실험 진행' 2단계에서 '실험 공간 등록'을 먼저 눌러 주세요.")
    detail = http("GET", f"{api}/api/buildings/{site['id']}", tok)
    tokens: dict[str, str] = {}
    for n in detail["nodes"]:
        if n["role"] == "rx" and n["name"] in names:
            tokens[n["name"]] = http("POST", f"{api}/api/nodes/{n['id']}/token", tok)["token"]
    return site["name"], tokens


class LiveTee:
    """녹화 도구가 받은 줄을 노드별로 모아 0.5초마다 서버로 보낸다(실시간 전송과 같은 형식)."""

    def __init__(self, col, api: str, tokens: dict[str, str]):
        self.col = col
        self.api = api
        self.tokens = tokens
        self.lock = threading.Lock()
        self.buf: dict[str, list] = {n: [] for n in tokens}
        self.headers: dict[str, list[str] | None] = {n: None for n in tokens}
        self.ports: dict = {}
        self.restarts_seen = {n: 0 for n in tokens}
        self.sent = {n: 0 for n in tokens}
        self.dropped = {n: 0 for n in tokens}
        self.fail_count = 0
        self.failing = False
        self.stop = threading.Event()
        self.threads: list[threading.Thread] = []

    def add(self, node: str, line: bytes, t: float) -> None:
        if node not in self.buf:
            return
        with self.lock:
            b = self.buf[node]
            b.append((t, line))
            if len(b) > MAX_BACKLOG:
                cut = len(b) - MAX_BACKLOG
                del b[:cut]
                self.dropped[node] += cut

    def start(self) -> None:
        for node in self.tokens:
            th = threading.Thread(target=self._loop, args=(node,), daemon=True, name=f"live-{node}")
            th.start()
            self.threads.append(th)

    def _frames(self, node: str, items: list) -> list[dict]:
        out = []
        for t, line in items:
            text = line.decode("utf-8", errors="ignore").strip()
            if text.startswith("type,"):
                self.headers[node] = [h.strip() for h in text.split(",")]
                continue
            try:
                rec = self.col.parse_esp_csi_record(text, self.headers[node])
            except Exception:  # 깨진 줄은 녹화 원본에만 남긴다
                continue
            if rec is None or len(rec.raw) < 2 or len(rec.raw) % 2:
                continue
            out.append({"t": t, "rssi": rec.rssi, "data": rec.raw})
        return out

    def _loop(self, node: str) -> None:
        token = self.tokens[node]
        pending: list[dict] = []
        while True:
            time.sleep(0.5)
            with self.lock:
                items, self.buf[node] = self.buf[node], []
            pending += self._frames(node, items)
            if not pending:
                if self.stop.is_set():
                    return
                continue
            batch = pending[:BATCH]
            restarted, now_restarts = False, None
            counter = getattr(self.ports.get(node), "restarts_since_open", None)
            if callable(counter):
                now_restarts = counter()
                restarted = now_restarts > self.restarts_seen[node]
            try:
                post_frames(self.api, token, batch, restarted)
                del pending[: len(batch)]
                self.sent[node] += len(batch)
                if restarted and now_restarts is not None:
                    self.restarts_seen[node] = now_restarts
                if self.failing:
                    self.failing = False
                    say("\n  [실시간] 서버 전송이 다시 됩니다.")
            except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
                self.fail_count += 1
                if not self.failing:
                    self.failing = True
                    say(f"\n  [실시간] 서버로 보내지 못했어요({str(exc)[:80]}). 녹화는 계속하고, 다시 되면 이어서 보내요.")
                pending = pending[-BATCH * 2:]
                if self.stop.is_set():
                    return
                time.sleep(1.0)
            if self.stop.is_set() and not pending:
                with self.lock:
                    if not self.buf[node]:
                        return

    def close(self, timeout: float = 8.0) -> None:
        self.stop.set()
        for th in self.threads:
            th.join(timeout=timeout)


def opt_value(argv: list[str], name: str) -> str | None:
    for i, a in enumerate(argv):
        if a == name and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith(name + "="):
            return a.split("=", 1)[1]
    return None


def node_names(argv: list[str]) -> list[str]:
    names = []
    for i, a in enumerate(argv):
        spec = None
        if a == "--node" and i + 1 < len(argv):
            spec = argv[i + 1]
        elif a.startswith("--node="):
            spec = a.split("=", 1)[1]
        if spec and "=" in spec:
            names.append(spec.split("=", 1)[0].strip())
    return names


def main() -> None:
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--api", default=os.environ.get("WATCHMATE_API", "http://127.0.0.1:8000"))
    ap.add_argument("--no-live", action="store_true")
    args, rest = ap.parse_known_args()
    api = args.api.rstrip("/")
    col = load_collector()
    if "-h" in rest or "--help" in rest:
        say(__doc__ or "")
        col.main(["session", "--help"])
        return

    # 화면에 지금 장면을 알려 주기 위해 장면 목록과 날짜를 읽는다(녹화 명령에 준 것과 같은 파일)
    plan_path, day = opt_value(rest, "--plan") or "docs/plans/day_plan.csv", opt_value(rest, "--day") or ""
    try:
        plan, _ = col._load_plan(Path(plan_path))
    except SystemExit:
        plan = []
    rec = RecState(plan, day)
    serve_rec(rec)
    orig_record_scene = col._record_scene

    def record_scene(sers, labels, seconds, countdown, out, day_, meta_extra, capture):
        scene = meta_extra.get("scene")
        rec.update(index=rec.names.index(scene) if scene in rec.names else -1, scene=scene,
                   description=meta_extra.get("description", ""), labels=dict(labels), phase="countdown",
                   phase_started=time.time(), phase_seconds=float(countdown))
        try:
            return orig_record_scene(sers, labels, seconds, countdown, out, day_, meta_extra, capture)
        finally:
            rec.update(phase="between", phase_started=time.time(), phase_seconds=0.0)

    col._record_scene = record_scene
    base_archive = col.RecordingArchive

    class SceneArchive(base_archive):  # type: ignore[misc, valid-type]
        def start_scene(self, session_ids, labels, csv_paths, seconds):
            wall = super().start_scene(session_ids, labels, csv_paths, seconds)
            rec.update(phase="recording", phase_started=wall, phase_seconds=float(seconds))
            return wall

    col.RecordingArchive = SceneArchive

    tee = None
    if not args.no_live:
        names = node_names(rest)
        if not names:
            sys.exit("--node RX-301=gw 처럼 녹화할 수신기를 주세요.")
        say("실시간 전송 준비")
        try:
            health = http("GET", f"{api}/api/health", timeout=20)
        except (urllib.error.URLError, TimeoutError, OSError):
            sys.exit(f"  ✗ 서버({api})에 연결할 수 없어요. 먼저 서버를 켜 주세요:\n"
                     "    cd C:\\wm\\watchmate-be; .\\.venv\\Scripts\\python -m uvicorn app.main:app --port 8000\n"
                     "  서버 없이 녹화만 하려면 --no-live를 붙이세요.")
        try:
            site_name, tokens = receiver_tokens(api, names)
        except urllib.error.HTTPError as exc:
            sys.exit(f"  ✗ 서버가 거절했어요({exc.code}). 로그인 정보(WATCHMATE_USER·WATCHMATE_PASSWORD)를 확인하세요.")
        missing = [n for n in names if n not in tokens]
        if not tokens:
            sys.exit("  ✗ 서버 실험 공간에 녹화할 수신기 이름이 없어요. 화면 2단계 등록과 --node 이름을 맞춰 주세요.")
        tee = LiveTee(col, api, tokens)
        base = col.RecordingArchive

        class LiveRecordingArchive(base):  # type: ignore[misc, valid-type]
            def __init__(self, ports, *a, **k):
                super().__init__(ports, *a, **k)
                tee.ports.update(ports)

            def receive(self, node, line):  # 녹화 도구의 수신 콜백. 원래 일을 먼저 하고 서버용으로 복사만 한다
                super().receive(node, line)
                tee.add(node, line, time.time())

        col.RecordingArchive = LiveRecordingArchive
        tee.start()
        say(f"  ✓ 서버 {api} · 모드 {health.get('mode')} · {site_name} · 실시간 수신기 {', '.join(tokens)}")
        if missing:
            say(f"  ! 서버에 없는 수신기는 녹화만 해요: {', '.join(missing)}")
        say("  화면에서 3단계(수신)가 완료되면, 첫 빈 방 동안 4단계 보정을 시작하세요.\n")

    try:
        col.main(["session", *rest])
    finally:
        rec.update(phase="done", running=False, phase_started=time.time(), phase_seconds=0.0)
        if tee is not None:
            tee.close()
            sent = ", ".join(f"{n} {c:,}개" for n, c in tee.sent.items())
            say(f"\n[실시간] 서버로 보낸 프레임: {sent}")
            lost = {n: c for n, c in tee.dropped.items() if c}
            if lost:
                say(f"[실시간] 서버가 오래 멈춰 보내지 못하고 버린 줄: {lost} (녹화 파일에는 모두 있음)")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        say("\n멈췄어요.")
