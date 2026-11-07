"""녹화(학습 데이터)를 하면서 같은 신호를 서버로도 보내 화면에서 실시간으로 본다.

watchmate-be의 `tools/collector.py session`을 그대로 실행하고, 녹화 도구가 받은 줄을 옆에서 서버로도 보낸다.
백엔드 파일은 바꾸지 않는다. 게이트웨이 USB 포트는 녹화 도구 하나만 연다(동시에 두 프로그램이 열 수 없기 때문).

실행(C:\\wm\\watchmate-be 폴더, .venv를 켠 PowerShell):
  $env:WATCHMATE_GATEWAY="COM7"
  python ..\\watchmate-fe\\scripts\\record_live.py --plan docs/field_tests/2026-11-07/plans/third_plan.csv --day 2026-11-07d `
      --out ..\\data\\sessions\\2026-11-07d --node RX-301=gw --node RX-302=gw --node RX-COR=gw `
      --countdown 20 --yes --notes "3차 측정"

  - session 옵션은 그대로 쓴다. 여기서만 쓰는 옵션: --api(기본 http://127.0.0.1:8000), --no-live(서버 없이 녹화만).
  - 서버 로그인: 환경 변수 WATCHMATE_USER·WATCHMATE_PASSWORD, 없으면 watchmate-be/.env의 DEMO_USERNAME·DEMO_PASSWORD,
    그것도 없으면 서버 기본값(demo). 실패하면 비밀번호를 물어본다(화면에 안 보임).
  - 수신기 토큰은 서버에서 새로 받아 이 프로그램 안에서만 쓴다(화면·파일에 남기지 않는다).
  - 실시간 모드에서는 로그인한 로컬 실험 화면을 열고 모든 구역을 비운 뒤 실행한다.
    공간 등록, 빈 방 보정(기본 180초), 감지 시작, 장면 진행 및 종료가 자동이다.
    화면이 없어지면 진행 중인 장면은 원본에 보존하고 복구 후 같은 장면부터 다시 측정한다.
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
from uuid import uuid4
from pathlib import Path

HERE = Path(__file__).resolve()
BE = Path(os.environ.get("WATCHMATE_BE") or HERE.parents[2] / "watchmate-be")
SITE_FLOOR = "S4-1동 2층"
MAX_BACKLOG = 20000  # 서버가 멈췄을 때 노드마다 쌓아 둘 줄 수(약 4분). 넘으면 오래된 것부터 버린다
BATCH = 500  # 한 번에 보내는 프레임 수. 크면 서버가 바쁠 때 한 요청이 오래 걸려 계속 밀린다
POST_TIMEOUT = 30.0  # 보정 직후 서버가 기준선을 계산하는 동안(수십 초) 기다린다
REC_PORT = int(os.environ.get("WATCHMATE_REC_PORT", "8765"))


class RecState:
    """화면에 알려 줄 지금 장면. 녹화 도구의 장면 시작·녹화 시작·장면 끝에서 바뀐다."""

    def __init__(self, plan: list[dict], day: str, synced: bool = False):
        self.lock = threading.Lock()
        self.last_ack = 0.0
        self.ack_version = -1
        self.plan = plan
        self.names = [p["scene"] for p in plan]
        self.data = {"sync": synced, "run_id": uuid4().hex, "version": 0, "building_id": None,
                     "incident_id": None, "started_at": None, "finished_at": None, "message": "",
                     "running": True, "day": day, "index": -1, "total": len(plan), "scene": None,
                     "description": "", "labels": {}, "phase": "idle", "phase_started": time.time(),
                     "phase_seconds": 0.0, "next": None}

    def update(self, **kw) -> None:
        with self.lock:
            self.data["version"] += 1
            self.data.update(kw)
            i = self.data["index"]
            nxt = self.plan[i + 1] if 0 <= i < len(self.plan) - 1 else None
            self.data["next"] = None if nxt is None else {"scene": nxt["scene"], "description": nxt["description"]}

    def acknowledge(self, run_id, version) -> bool:
        with self.lock:
            if run_id != self.data["run_id"] or version != self.data["version"]:
                return False
            self.ack_version = version
            self.last_ack = time.monotonic()
            return True

    def wait_screen(self, capture=None, ready=None):
        while True:
            if capture:
                capture.check()
            with self.lock:
                if self.ack_version == self.data["version"] and time.monotonic() - self.last_ack < 7 and (ready is None or ready()):
                    return
            time.sleep(0.1)

    def screen_present(self):
        with self.lock:
            return time.monotonic() - self.last_ack < 7

    def snapshot(self) -> dict:
        with self.lock:
            return dict(self.data, now=time.time())


def serve_rec(state: RecState):
    class Handler(http_server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.path.split("?")[0] not in ("/rec/scene", "/scene"):
                self.send_error(404)
                return
            body = json.dumps(state.snapshot(), ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if self.path != "/rec/ack" or self.headers.get_content_type() != "application/json":
                self.send_error(404)
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 1024:
                    raise ValueError
                ack = json.loads(self.rfile.read(size))
                ok = state.acknowledge(ack["run_id"], ack["version"])
            except (ValueError, KeyError, TypeError):
                self.send_error(400)
                return
            self.send_response(204 if ok else 409)
            self.end_headers()

        def log_message(self, *args):  # 녹화 화면을 어지럽히지 않는다
            pass

    try:
        srv = http_server.ThreadingHTTPServer(("127.0.0.1", REC_PORT), Handler)
    except OSError as exc:
        if state.data["sync"]:
            sys.exit(f"화면 연동 포트 {REC_PORT}가 사용 중입니다. 기존 녹화 도우미를 확인하세요.")
        say(f"  ! 화면 연동 포트 {REC_PORT}를 열지 못했어요({exc}). 녹화는 그대로 하고, 실제 상태는 화면에서 손으로 입력하세요.")
        return
    threading.Thread(target=srv.serve_forever, daemon=True, name="rec-state").start()
    return srv


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


def receiver_tokens(api: str, names: list[str]):
    """화면 2단계에서 등록한 실험 공간을 찾아, 녹화할 수신기의 토큰을 새로 받는다."""
    tok = login(api)
    buildings = http("GET", f"{api}/api/buildings", tok)
    site = next((b for b in buildings if b.get("floor_label") == SITE_FLOOR and not b.get("is_demo")), None)
    if site is None:
        sys.exit("  ✗ 서버에 실험 공간이 없어요. 화면 '실험 진행' 2단계에서 '실험 공간 등록'을 먼저 눌러 주세요.")
    detail = http("GET", f"{api}/api/buildings/{site['id']}", tok)
    rx = {n["name"]: n for n in detail["nodes"] if n["role"] == "rx" and n["name"] in names}
    if set(rx) != set(names) or any(n["zone_id"] is None for n in rx.values()):
        sys.exit("공간에 등록된 수신기 이름·구역과 --node가 맞는지 확인하세요.")
    if detail["active_incident"] or (detail["calibration"] or {}).get("status") == "running":
        sys.exit("다른 감지 또는 보정이 진행 중입니다. 해당 측정을 마친 뒤 실행하세요.")
    tokens: dict[str, str] = {}
    for n in detail["nodes"]:
        if n["role"] == "rx" and n["name"] in names:
            tokens[n["name"]] = http("POST", f"{api}/api/nodes/{n['id']}/token", tok)["token"]
    return tok, site, tokens


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
        self.delivered_at = {n: 0.0 for n in tokens}
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
                self.delivered_at[node] = batch[-1]["t"]
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


class ScreenLost(Exception):
    """An unfinished labelled take must be repeated; its continuous raw data remains."""


class Measurement:
    def __init__(self, rec, api, token, site, names, calibration_seconds, tee):
        self.rec, self.api, self.token = rec, api, token
        self.site_url = f"{api}/api/buildings/{site['id']}"
        self.names = names
        self.calibration_seconds = calibration_seconds
        self.tee = tee
        self.incident_id = None
        self.rec.update(building_id=site["id"])

    def wait(self, capture, phase, message, **changes):
        say(message)
        self.rec.update(phase=phase, phase_started=time.time(), phase_seconds=0,
                        message=message, **changes)
        self.rec.wait_screen(capture, self.receiving if phase == "armed" else None)

    def receiving(self):
        return all(time.time() - self.tee.delivered_at[n] < 7 for n in self.names)

    def prepare(self, capture, countdown):
        self.wait(capture, "preparing", "빈 방 보정 준비 · 모든 구역을 비우고 실험 진행 화면을 열어 두세요.")
        capture.wait(countdown)
        while not all(self.tee.sent[n] for n in self.names):
            capture.wait(0.25)
        self.wait(capture, "calibrating", "빈 방 기준선을 자동 보정합니다. 감지가 시작될 때까지 밖에서 기다리세요.")
        detail = http("POST", self.site_url + "/calibration/start", self.token,
                      {"duration_seconds": self.calibration_seconds}, timeout=90)
        run_id = detail["calibration"]["id"]
        while detail["calibration"]["status"] == "running":
            capture.wait(1)
            try:
                detail = http("GET", self.site_url, self.token, timeout=90)
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                if isinstance(exc, urllib.error.HTTPError) and exc.code < 500:
                    raise
                continue
            if not detail["calibration"] or detail["calibration"]["id"] != run_id:
                sys.exit("다른 보정이 시작되었습니다. 이번 측정을 중단합니다.")
        results = detail["calibration"]["result"] or {}
        valid = {r.get("node") for r in results.values() if isinstance(r, dict) and r.get("ok")}
        missing = sorted(set(self.names) - valid)
        if missing:
            sys.exit(f"이번 빈 방 보정에 실패했습니다: {', '.join(missing)}. 본 측정은 시작하지 않았습니다.")
        self.wait(capture, "starting", "보정 완료 · 화면과 연결한 뒤 감지를 시작합니다.")
        incident = http("POST", self.site_url + "/incidents", self.token,
                        {"measurement": True, "note": "실측 자동 녹화 " + self.rec.data["run_id"]})
        if not incident.get("created"):
            sys.exit("다른 감지가 시작되었습니다. 해당 기록과 섞이지 않도록 중단합니다.")
        self.incident_id = incident["id"]
        self.rec.update(incident_id=self.incident_id)

    def close(self):
        if self.incident_id:
            http("POST", f"{self.api}/api/incidents/{self.incident_id}/close", self.token, timeout=60)


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
    ap.add_argument("--calibration-seconds", type=int, default=180, choices=range(20, 601), metavar="20..600")
    args, rest = ap.parse_known_args()
    api = args.api.rstrip("/")
    col = load_collector()
    if "-h" in rest or "--help" in rest:
        say(__doc__ or "")
        col.main(["session", "--help"])
        return

    # 화면에 지금 장면을 알려 주기 위해 장면 목록과 날짜를 읽는다(녹화 명령에 준 것과 같은 파일)
    plan_path, day = opt_value(rest, "--plan") or "docs/plans/day_plan.csv", opt_value(rest, "--day") or ""
    plan, _ = col._load_plan(Path(plan_path))
    rec = RecState(plan, day, synced=not args.no_live)
    server = serve_rec(rec)
    measurement = None
    orig_record_scene = col._record_scene

    def record_scene(sers, labels, seconds, countdown, out, day_, meta_extra, capture):
        if measurement and measurement.incident_id is None:
            measurement.prepare(capture, countdown)
        scene = meta_extra["scene"]
        changes = dict(index=rec.names.index(scene), scene=scene,
                       description=meta_extra["description"], labels=dict(labels))
        while True:
            if measurement:
                measurement.wait(capture, "waiting", "장면이 실험 화면에 표시되면 이동 시간을 시작합니다.",
                                 **changes, started_at=None, finished_at=None)
            rec.update(**changes, phase="countdown", phase_started=time.time(), phase_seconds=float(countdown))
            try:
                saved = orig_record_scene(sers, labels, seconds, countdown, out, day_, meta_extra, capture)
            except ScreenLost:
                say("화면 연결이 끊겼습니다. 연속 원본을 보존하고 화면 복구 후 이 장면을 다시 측정합니다.")
                continue
            finished = rec.data["started_at"] + next(iter(saved.values()))[2]
            rec.update(phase="between", phase_started=finished, finished_at=finished,
                       phase_seconds=0.0, message="장면 종료 · 화면 기록 저장 확인 중")
            if measurement:
                rec.wait_screen(capture)
            return saved

    col._record_scene = record_scene
    base_archive = col.RecordingArchive

    class SceneArchive(base_archive):
        def start_scene(self, session_ids, labels, csv_paths, seconds):
            if measurement:
                measurement.wait(self, "armed", "이 장면의 표시와 실시간 수신이 확인되면 녹화를 시작합니다.")
            wall = super().start_scene(session_ids, labels, csv_paths, seconds)
            rec.update(phase="recording", phase_started=wall, started_at=wall, phase_seconds=float(seconds),
                       message="녹화 중")
            return wall

        def wait(self, seconds):
            super().wait(seconds)
            if measurement and rec.data["phase"] == "recording" and (not rec.screen_present() or not measurement.receiving()):
                raise ScreenLost()

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
        rec.update(phase="setup", requested_nodes=names, message="실험 공간을 준비합니다. 로그인한 실험 진행 화면을 열어 두세요.")
        say(rec.data["message"])
        rec.wait_screen()
        try:
            token, site, tokens = receiver_tokens(api, names)
        except urllib.error.HTTPError as exc:
            sys.exit(f"  ✗ 서버가 거절했어요({exc.code}). 로그인 정보(WATCHMATE_USER·WATCHMATE_PASSWORD)를 확인하세요.")
        if not tokens:
            sys.exit("  ✗ 서버 실험 공간에 녹화할 수신기 이름이 없어요. 화면 2단계 등록과 --node 이름을 맞춰 주세요.")
        tee = LiveTee(col, api, tokens)
        measurement = Measurement(rec, api, token, site, names, args.calibration_seconds, tee)
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
        say(f"  ✓ 서버 {api} · 모드 {health.get('mode')} · {site['name']} · 실시간 수신기 {', '.join(tokens)}")
        if "--yes" not in rest:
            rest.append("--yes")
    try:
        col.main(["session", *rest])
    finally:
        rec.update(phase="done", running=False, phase_started=time.time(), phase_seconds=0.0)
        if server:
            server.shutdown()
            server.server_close()
        if tee is not None:
            tee.close()
            sent = ", ".join(f"{n} {c:,}개" for n, c in tee.sent.items())
            say(f"\n[실시간] 서버로 보낸 프레임: {sent}")
            lost = {n: c for n, c in tee.dropped.items() if c}
            if lost:
                say(f"[실시간] 서버가 오래 멈춰 보내지 못하고 버린 줄: {lost} (녹화 파일에는 모두 있음)")
        if measurement:
            measurement.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        say("\n멈췄어요.")
