"""녹화(학습 데이터)를 하면서 같은 신호를 서버로도 보내 화면에서 실시간으로 본다.

watchmate-be의 `tools/collector.py session`을 그대로 실행하고, 녹화 도구가 받은 줄을 옆에서 서버로도 보낸다.
백엔드 파일은 바꾸지 않는다. 게이트웨이 USB 포트는 녹화 도구 하나만 연다(동시에 두 프로그램이 열 수 없기 때문).

실행(C:\\wm\\watchmate-be 폴더, .venv를 켠 PowerShell):
  $env:WATCHMATE_GATEWAY="COM7"
  python ..\\watchmate-fe\\scripts\\record_live.py --plan docs/field_tests/2026-11-07/plans/third_plan.csv --day 2026-11-07d `
      --out ..\\data\\sessions\\2026-11-07d --node RX-301=gw --node RX-302=gw --node RX-COR=gw `
      --countdown 20 --yes --notes "3차 측정"

  - session 옵션은 그대로 쓴다. 여기서만 쓰는 옵션: --api(기본 http://127.0.0.1:8000), --no-live(서버 없이 녹화만),
    --calibration-seconds(빈 방 보정 초, 기본 180), --max-tau(보정 문턱 상한, 기본 3.0).
  - 측정 한 번(보정부터 마지막 장면까지)마다 --day와 --out을 새로 준다(예: 2026-11-08, 2026-11-08b, …).
    학습은 --day마다 그 측정의 빈 방으로 기준선을 잡고, 측정 하나씩 빼고 채점한다.
  - 서버 로그인: 환경 변수 WATCHMATE_USER·WATCHMATE_PASSWORD, 없으면 watchmate-be/.env의 DEMO_USERNAME·DEMO_PASSWORD,
    그것도 없으면 서버 기본값(demo). 실패하면 비밀번호를 물어본다(화면에 안 보임).
  - 수신기 토큰은 서버에서 새로 받아 이 프로그램 안에서만 쓴다(화면·파일에 남기지 않는다).
  - 실시간 모드에서는 로그인한 로컬 실험 화면을 열고 모든 구역을 비운 뒤 실행한다.
    공간 등록, 빈 방 보정(기본 180초), 감지 시작, 장면 진행 및 종료가 자동이다.
    녹화 중에는 화면이 가려지거나 다른 창을 봐도 계속 녹화한다(장면 사이에는 화면 표시를 기다린다).
    서버 전송이 60초 넘게 끊기면 진행 중인 장면은 원본에 보존하고 같은 장면부터 다시 측정한다.
  - 보정 문턱이 --max-tau를 넘거나 판정이 적으면 한 번 더 보정하고, 또 그러면 본 측정 없이 멈춘다.
  - 보정 뒤 첫 빈 방 장면에서 '가능' 이상이 20%를 넘는 보드가 있으면(보정 직후 신호가 움직임) 그 장면 파일을
    excluded_recal 폴더로 옮기고 다시 보정한 뒤 빈 방 장면부터 다시 찍는다(최대 2번).
  - 보정 뒤 보드가 다시 켜지면 멈추고, 끊긴 장면부터 이어 찍는 명령(--day·--out 새 값, --start)을 알려 준다.
"""

from __future__ import annotations

import argparse
import getpass
import http.server as http_server
import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from uuid import uuid4
from pathlib import Path

HERE = Path(__file__).resolve()
BE = Path(os.environ.get("WATCHMATE_BE") or HERE.parents[2] / "watchmate-be")
SITE_FLOOR = "S4-1동 2층"
MAX_BACKLOG = 20000  # 서버가 멈췄을 때 노드마다 쌓아 둘 줄 수(약 4분). 넘으면 오래된 것부터 버린다
BATCH = 500  # 한 번에 보내는 프레임 수. 크면 서버가 바쁠 때 한 요청이 오래 걸려 계속 밀린다
POST_TIMEOUT = 30.0  # 보정 직후 서버가 기준선을 계산하는 동안(수십 초) 기다린다
REC_PORT = int(os.environ.get("WATCHMATE_REC_PORT", "8765"))
WAIT_NOTE_SECONDS = 15  # 화면·수신을 이만큼 넘게 기다리면 무엇을 기다리는지 창에 적는다
# 보정 점검(화면 src/lib/protocol.ts와 같은 기준). RSSI 척도 바닥값이 있는 서버는 빈 방이면 문턱이 2 안팎이다.
CAL_MAX_TAU = 3.0  # 이보다 높으면 보정 중에 구역·복도에서 무언가 움직였다
CAL_MIN_WINDOWS = 60  # 2분 이상 보정에서 판정(2초 창)이 이보다 적으면 문턱이 불안정하다(보정 초의 1/3까지만 요구)
CAL_TRIES = 2  # 미덥지 않은 보정은 한 번 더 한다
CAL_RETRY_WAIT = 20  # 다시 보정하기 전에 구역에서 나올 시간(초)
# 첫 빈 방 점검. 6차 223호는 보정 2~3분 뒤 RSSI가 1dB 내려가 빈 방·옆 구역에서 헛경보가 이어졌다
# (같은 기록을 3분 늦은 빈 방으로 기준선을 잡으면 거의 다 맞음). 보정 뒤 첫 빈 방 장면에서 '가능' 이상(p ≥ 가능 기준,
# 지수 평균 0.5·품질 0.7 미만 제외·장면 앞 20초 제외)이 이 비율을 넘는 보드가 있으면 다시 보정하고 빈 방부터 다시 찍는다.
QUIET_MAX_SHARE = 0.20
QUIET_TRIES = 2  # 다시 보정하는 최대 횟수. 다 쓰면 경고만 하고 진행한다
QUIET_SETTLE = 20.0  # 장면 앞 이 초는 세지 않는다(채점과 같음). 짧은 장면은 길이의 1/3
QUIET_MIN_QUALITY = 0.7
EXCLUDED_DIR = "excluded_recal"  # 다시 찍게 된 장면 파일을 옮겨 두는 녹화 폴더 안 폴더(채점·학습에서 빠짐)
# 녹화 중 서버 전송이 이 초보다 오래 끊기면 그 장면을 다시 찍는다. 짧게 끊기면 모아 두었다가 이어서 보내므로 계속 녹화한다.
# 화면 확인(창이 가려지거나 다른 창을 봄)은 녹화 중에는 멈출 이유로 쓰지 않는다(장면 사이에는 화면 표시를 기다린다).
DELIVERY_GRACE = 60.0
NODE_STATUS_KO = {
    ("stale", "restarted"): "다시 켜짐(재보정 필요)",
    ("stale", "low_rate"): "프레임 부족",
    ("stale", None): "신호 끊김",
    ("warming", None): "판단 준비 중",
    ("uncalibrated", None): "보정 안 됨",
}


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

    def wait_screen(self, capture=None, ready=None, guard=None, explain=None):
        """화면이 지금 단계를 그렸다고 확인할 때까지 기다린다.

        guard는 기다리는 동안 계속 불러 멈춰야 할 일(보드 재시작)을 예외로 알린다.
        explain은 WAIT_NOTE_SECONDS마다 불러 무엇을 기다리는지 창에 적는다.
        """
        started = time.monotonic()
        next_note = started + WAIT_NOTE_SECONDS
        while True:
            if capture:
                capture.check()
            if guard:
                guard()
            with self.lock:
                if self.ack_version == self.data["version"] and time.monotonic() - self.last_ack < 7 and (ready is None or ready()):
                    return
            now = time.monotonic()
            if explain and now >= next_note:
                explain(now - started)
                next_note = now + WAIT_NOTE_SECONDS
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


def server_db() -> Path:
    """서버와 같은 DB 파일: DATABASE_URL, 없으면 watchmate-be/.env의 값, 그것도 없으면 watchmate-be/data/app.db."""
    url = os.environ.get("DATABASE_URL", "").strip() or read_env_file(BE / ".env").get("DATABASE_URL", "")
    if url.startswith("sqlite:///"):
        path = Path(url[len("sqlite:///"):])
        return path if path.is_absolute() else BE / path
    return BE / "data" / "app.db"


def utc_epoch(value) -> float:
    dt = datetime.fromisoformat(str(value).replace("T", " "))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)  # 서버는 UTC로 저장한다
    return dt.timestamp()


def quiet_shares(db: Path, incident_id: int, names: list[str], start: float, end: float,
                 possible: float) -> dict[str, tuple[float, int]]:
    """감지 하나에서 [start + 앞부분, end] 동안 보드별 '가능' 이상 비율과 판정 수(채점과 같은 지수 평균·품질 기준)."""
    settle = min(QUIET_SETTLE, max(0.0, (end - start) / 3))
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True, timeout=10)
    try:
        rows = con.execute("select n.name, i.t, i.p_change, i.p_person, i.quality from inferences i "
                           "join nodes n on n.id = i.node_id where i.incident_id = ? order by i.t",
                           (incident_id,)).fetchall()
    finally:
        con.close()
    ema: dict[str, float] = {}
    vals: dict[str, list[float]] = {n: [] for n in names}
    for name, t, pc, pp, q in rows:
        p = pp if pp is not None else pc
        if name not in vals or p is None or (q is not None and q < QUIET_MIN_QUALITY):
            continue
        e = ema[name] = p if name not in ema else 0.5 * p + 0.5 * ema[name]
        if start + settle <= utc_epoch(t) <= end:
            vals[name].append(e)
    return {n: ((sum(x >= possible for x in v) / len(v)) if v else 0.0, len(v)) for n, v in vals.items()}


def set_aside(saved: dict) -> Path | None:
    """다시 찍을 장면 파일(.csv·.json)을 녹화 폴더 안 excluded_recal로 옮긴다. 지우지 않는다."""
    dest = None
    for path, _frames, _took in saved.values():
        dest = Path(path).parent / EXCLUDED_DIR
        dest.mkdir(exist_ok=True)
        for p in (Path(path), Path(path).with_suffix(".json")):
            if p.exists():
                p.replace(dest / p.name)
    return dest


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


class NodeRestarted(Exception):
    """보정 뒤 수신 보드가 다시 켜졌다. 보드가 신호 크기 기준을 새로 잡아 이번 기준선으로는 판단할 수 없다.

    서버도 그 보드를 재보정 전까지 판단에서 빼므로 화면이 '녹화 시작 대기'를 확인하지 않는다.
    기다리지 않고 진행 중인 장면을 지운 뒤 측정을 끝낸다.
    """

    def __init__(self, nodes: list[str], during_calibration: bool = False):
        super().__init__(", ".join(nodes))
        self.nodes = nodes
        self.during_calibration = during_calibration


class Measurement:
    def __init__(self, rec, api, token, site, names, calibration_seconds, tee, max_tau=CAL_MAX_TAU):
        self.rec, self.api, self.token = rec, api, token
        self.site_url = f"{api}/api/buildings/{site['id']}"
        self.names = names
        self.calibration_seconds = calibration_seconds
        self.max_tau = max_tau
        self.tee = tee
        self.incident_id = None
        self.restart_base: dict[str, int] | None = None  # 보정을 마쳤을 때 보드별 재시작 횟수
        self.quiet_left = QUIET_TRIES  # 첫 빈 방 점검으로 다시 보정할 수 있는 남은 횟수
        self.quiet_done = False
        self.cal_running = False  # 서버에 이 실행이 시작한 보정이 돌고 있는지
        self.lost_since: float | None = None  # 녹화 중 서버 전송이 끊긴 시각
        self.screen_gone = False  # 녹화 중 화면 확인이 끊겼다고 이미 알렸는지
        self.rec.update(building_id=site["id"])

    def wait(self, capture, phase, message, **changes):
        say(message)
        self.rec.update(phase=phase, phase_started=time.time(), phase_seconds=0,
                        message=message, **changes)
        self.wait_screen(capture, self.receiving if phase == "armed" else None)

    def wait_screen(self, capture, ready=None):
        self.rec.wait_screen(capture, ready, guard=self.check_restarts, explain=self.explain_wait)

    def receiving(self):
        return all(time.time() - self.tee.delivered_at[n] < 7 for n in self.names)

    def restart_counts(self) -> dict[str, int]:
        """수집 포트가 센, 이 명령을 시작한 뒤 보드별 재시작 횟수. 셀 수 없는 포트는 빠진다."""
        out = {}
        for n in self.names:
            counter = getattr(self.tee.ports.get(n), "restarts_since_open", None)
            if callable(counter):
                out[n] = counter()
        return out

    def check_restarts(self) -> None:
        if self.restart_base is None:  # 보정 전이면 비교할 기준이 없다(보정 중 재시작은 prepare에서 본다)
            return
        now = self.restart_counts()
        hit = sorted(n for n, c in now.items() if c > self.restart_base.get(n, c))
        if hit:
            raise NodeRestarted(hit)

    def explain_wait(self, waited: float) -> None:
        reasons = []
        if not self.rec.screen_present():
            reasons.append("실험 진행 화면의 확인이 없어요(화면 꺼짐·가려짐·다른 페이지)")
        now = time.time()
        for n in self.names:
            sent_at = self.tee.delivered_at[n]
            if sent_at and now - sent_at >= 7:
                reasons.append(f"{n} 신호가 {now - sent_at:.0f}초째 서버에 안 들어가요")
        if self.incident_id:
            try:
                st = http("GET", f"{self.api}/api/incidents/{self.incident_id}/state", self.token, timeout=5)
                for node in st.get("nodes", []):
                    if node.get("role") == "rx" and node.get("name") in self.names and node.get("status") != "ok":
                        key = (node.get("status"), node.get("reason"))
                        text = NODE_STATUS_KO.get(key) or NODE_STATUS_KO.get((key[0], None)) or str(key[0])
                        reasons.append(f"{node['name']} {text}")
            except (urllib.error.URLError, TimeoutError, OSError, ValueError, AttributeError):
                reasons.append("서버 상태를 읽지 못했어요")
        say(f"  … {waited:.0f}초째 기다리는 중: " + ("; ".join(reasons) if reasons else "화면이 이 단계를 그리기를 기다려요"))

    def prepare(self, capture, countdown, reason: str = ""):
        self.wait(capture, "preparing", (reason + " " if reason else "")
                  + "빈 방 보정 준비 · 모든 구역을 비우고 실험 진행 화면을 열어 두세요.")
        capture.wait(countdown)
        while not all(self.tee.sent[n] for n in self.names):
            capture.wait(0.25)
        message = "빈 방 기준선을 자동 보정합니다. 감지가 시작될 때까지 밖에서 기다리세요."
        for attempt in range(1, CAL_TRIES + 1):
            self.wait(capture, "calibrating", message)
            restarts_before = self.restart_counts()
            results = self.calibrate(capture)
            valid = {r.get("node") for r in results.values() if isinstance(r, dict) and r.get("ok")}
            missing = sorted(set(self.names) - valid)
            if missing:
                sys.exit(f"이번 빈 방 보정에 실패했습니다: {', '.join(missing)}. 본 측정은 시작하지 않았습니다.")
            restarts_after = self.restart_counts()
            during = sorted(n for n, c in restarts_after.items() if c > restarts_before.get(n, c))
            if during:
                raise NodeRestarted(during, during_calibration=True)
            say("  보정 결과: " + self.calibration_summary(results))
            issues = self.calibration_issues(results)
            if not issues:
                break
            if attempt == CAL_TRIES:
                sys.exit(f"빈 방 보정이 {CAL_TRIES}번 모두 미덥지 않았어요({', '.join(issues)}). 본 측정은 시작하지 않았어요.\n"
                         "  빈 방이면 문턱은 2 안팎이에요. 보정하는 동안 구역·복도에서 움직인 사람이나 물건(문, 선풍기)이\n"
                         "  없었는지 확인하고 같은 명령으로 다시 실행하세요. 아직 찍은 장면이 없어서 --day는 그대로 써도 돼요.\n"
                         "  아무도 없는데도 문턱이 계속 높으면 --max-tau 4처럼 기준을 올려 진행할 수 있어요(그만큼 사람을 덜 잡아요).")
            self.wait(capture, "calibrating",
                      f"보정이 미덥지 않아요({', '.join(issues)}). 빈 방이면 문턱은 2 안팎이에요. "
                      f"모두 구역 밖에 있는지 확인하세요. {CAL_RETRY_WAIT}초 뒤 한 번 더 보정합니다.")
            capture.wait(CAL_RETRY_WAIT)
            message = "빈 방 기준선을 한 번 더 보정합니다. 감지가 시작될 때까지 밖에서 기다리세요."
        self.restart_base = restarts_after
        self.wait(capture, "starting", "보정 완료 · 화면과 연결한 뒤 감지를 시작합니다.")
        incident = http("POST", self.site_url + "/incidents", self.token,
                        {"measurement": True, "note": "실측 자동 녹화 " + self.rec.data["run_id"]})
        if not incident.get("created"):
            sys.exit("다른 감지가 시작되었습니다. 해당 기록과 섞이지 않도록 중단합니다.")
        self.incident_id = incident["id"]
        self.rec.update(incident_id=self.incident_id)

    def calibrate(self, capture) -> dict:
        """빈 방 보정을 한 번 하고, 끝나면 수신기별 결과(ok, windows, tau, fps)를 돌려준다."""
        detail = http("POST", self.site_url + "/calibration/start", self.token,
                      {"duration_seconds": self.calibration_seconds}, timeout=90)
        run_id = detail["calibration"]["id"]
        self.cal_running = True  # 보정 중에 멈추면 close()가 서버 보정도 멈춘다(남아 있으면 다음 실행이 막힘)
        while detail["calibration"]["status"] == "running":
            capture.wait(1)
            try:
                detail = http("GET", self.site_url, self.token, timeout=90)
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                if isinstance(exc, urllib.error.HTTPError) and exc.code < 500:
                    raise
                continue
            if not detail["calibration"] or detail["calibration"]["id"] != run_id:
                self.cal_running = False
                sys.exit("다른 보정이 시작되었습니다. 이번 측정을 중단합니다.")
        self.cal_running = False
        return detail["calibration"]["result"] or {}

    def my_results(self, results: dict) -> list[dict]:
        rows = [r for r in results.values() if isinstance(r, dict) and r.get("node") in self.names]
        return sorted(rows, key=lambda r: r["node"])

    def calibration_issues(self, results: dict) -> list[str]:
        """미덥지 않은 수신기: 문턱이 --max-tau보다 높거나, 2분 이상 보정인데 판정(2초 창)이 적다."""
        min_windows = min(CAL_MIN_WINDOWS, self.calibration_seconds // 3) if self.calibration_seconds >= 120 else 0
        issues = []
        for r in self.my_results(results):
            tau, windows = r.get("tau"), r.get("windows")
            if isinstance(tau, (int, float)) and tau > self.max_tau:
                issues.append(f"{r['node']} 문턱 {tau:.1f}")
            elif isinstance(windows, int) and windows < min_windows:
                issues.append(f"{r['node']} 판정 {windows}개")
        return issues

    def calibration_summary(self, results: dict) -> str:
        parts = []
        for r in self.my_results(results):
            tau = r.get("tau")
            parts.append(f"{r['node']} 문턱 {tau:.1f}·판정 {r.get('windows', '?')}개" if isinstance(tau, (int, float))
                         else f"{r['node']} {'성공' if r.get('ok') else '실패'}")
        return ", ".join(parts)

    def recording_stalled(self) -> bool:
        """녹화 중 점검. 화면 확인이 끊겨도 녹화는 계속하고(한 번만 알림), 서버 전송이 DELIVERY_GRACE초 넘게 끊기면 True."""
        present = self.rec.screen_present()
        if not present and not self.screen_gone:
            say("\n  (실험 화면 확인이 끊겼어요 · 창이 가려졌거나 다른 창을 보는 중 · 녹화는 계속해요)")
        self.screen_gone = not present
        if self.receiving():
            self.lost_since = None
            return False
        now = time.time()
        if self.lost_since is None:
            self.lost_since = now
            say("\n  (서버 전송이 잠깐 끊겼어요 · 녹화는 계속하고, 다시 되면 모아 둔 신호를 이어서 보내요)")
        return now - self.lost_since > DELIVERY_GRACE

    def wants_quiet_check(self, labels: dict) -> bool:
        """보정 뒤 첫 빈 방 장면(모든 보드 라벨이 empty)인지."""
        return not self.quiet_done and bool(labels) and all(v == "empty" for v in labels.values())

    def possible_p(self) -> float:
        try:
            st = http("GET", f"{self.api}/api/incidents/{self.incident_id}/state", self.token, timeout=5)
            return float(st["thresholds"]["possible"])
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError, TypeError):
            return 0.20

    def quiet_issues(self, start: float, end: float) -> list[str]:
        """첫 빈 방 장면에서 '가능' 이상이 QUIET_MAX_SHARE를 넘은 보드. 읽지 못하면 빈 목록(점검 건너뜀)."""
        if os.environ.get("WATCHMATE_FORCE_RECAL") == "1" and self.quiet_left == QUIET_TRIES:
            say("  첫 빈 방 점검: 시험용으로 한 번 다시 보정합니다(WATCHMATE_FORCE_RECAL=1).")
            return ["시험용 강제 재보정"]
        db = server_db()
        if not db.exists():
            say(f"  첫 빈 방 점검: 서버 DB({db})를 찾지 못해 건너뜁니다.")
            return []
        try:
            shares = quiet_shares(db, self.incident_id, self.names, start, end, self.possible_p())
        except sqlite3.Error as exc:
            say(f"  첫 빈 방 점검: 서버 기록을 읽지 못해 건너뜁니다({exc}).")
            return []
        parts, issues = [], []
        for n, (share, count) in shares.items():
            if not count:
                parts.append(f"{n} 판정 없음")
                continue
            parts.append(f"{n} '가능' 이상 {share:.0%}")
            if share > QUIET_MAX_SHARE:
                issues.append(f"{n} '가능' 이상 {share:.0%}")
        say("  첫 빈 방 점검(보정 직후 신호가 움직였는지): " + " · ".join(parts) + ("" if issues else " → 통과"))
        return issues

    def recalibrate(self, capture, countdown, issues: list[str]) -> None:
        """감지를 닫고 지금 빈 방으로 다시 보정한 뒤 새 감지를 연다(첫 빈 방 장면은 다시 찍는다)."""
        self.quiet_left -= 1
        reason = f"보정 직후 빈 방에서 흔들린 보드({', '.join(issues)})가 있어 기준선을 다시 잡습니다."
        say(f"  ✗ {reason}\n    방금 빈 방 장면 파일은 {EXCLUDED_DIR} 폴더로 옮겼어요(지우지 않음). "
            "다시 보정한 뒤 빈 방 장면부터 다시 찍습니다. 모두 구역 밖에 그대로 계세요.")
        self.close()
        self.incident_id = None
        self.rec.update(incident_id=None)
        self.restart_base = None
        self.prepare(capture, countdown, reason)

    def close(self):
        if self.cal_running:  # 보정 도중 멈춤(Ctrl+C 등): 서버 보정도 멈춘다
            try:
                http("POST", self.site_url + "/calibration/stop", self.token, timeout=30)
            except (urllib.error.URLError, TimeoutError, OSError):
                pass
            self.cal_running = False
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


def next_day(day: str) -> str:
    """측정 이름의 끝 글자를 다음 것으로: 2026-11-08 → 2026-11-08b, 2026-11-08b → 2026-11-08c."""
    if not day:
        return time.strftime("%Y-%m-%d") + "b"
    if len(day) > 1 and "a" <= day[-1] < "z" and not day[-2].isalpha():
        return day[:-1] + chr(ord(day[-1]) + 1)
    return day + "b"


def with_options(argv: list[str], changes: dict[str, str]) -> list[str]:
    """명령 인자에서 옵션 값만 바꾼다(--name 값, --name=값 둘 다). 없던 옵션은 뒤에 붙인다."""
    out, seen, i = [], set(), 0
    while i < len(argv):
        name = argv[i].split("=", 1)[0]
        if name in changes:
            out += [name, changes[name]]
            seen.add(name)
            i += 1 if "=" in argv[i] else 2
            continue
        out.append(argv[i])
        i += 1
    for name, value in changes.items():
        if name not in seen:
            out += [name, value]
    return out


def restart_guidance(exc: NodeRestarted, stopped_at: tuple[str, int], plan: list[dict], argv: list[str]) -> str:
    """보드가 다시 켜진 뒤 다시 찍는 방법. 끝난 장면은 그대로 두고, 끊긴 장면부터 새 --day로 이어 찍는다."""
    lines = ["  다시 하려면",
             "    1. 보드 전원(충전기·케이블)을 확인합니다.",
             "    2. 측정 구역을 비우고 실험 진행 화면을 열어 둡니다."]
    phase, index = stopped_at
    if exc.during_calibration or index < 0:
        lines.append("    3. 같은 명령을 그대로 다시 실행합니다. 아직 찍은 장면이 없어서 --day는 그대로 써도 돼요.")
        return "\n".join(lines)
    start = index + 1 if phase == "between" else index  # 'between'이면 그 장면은 저장까지 끝났다
    if start >= len(plan):
        return "  마지막 장면까지 저장했어요. 이번 측정은 다시 찍지 않아도 돼요."
    if not any(all(v == "empty" for v in p["labels"].values()) for p in plan[start:]):
        start = 0  # 남은 장면에 빈 방이 없으면 새 --day의 빈 방 기준을 잡을 수 없어서 처음부터 찍는다
    day, out = opt_value(argv, "--day") or "", Path(opt_value(argv, "--out") or "sessions")
    new_day = next_day(day)
    while (out.parent / new_day).exists():
        new_day = next_day(new_day)
    changes = {"--day": new_day, "--out": str(out.parent / new_day), "--start": plan[start]["scene"]}
    cmd = subprocess.list2cmdline([sys.executable, sys.argv[0], *with_options(sys.argv[1:], changes)])
    lines += [f"    3. {plan[start]['scene']} 장면부터 찍습니다. --day를 새 값({new_day})으로, --out을 새 폴더로 바꾼 명령이에요"
              + ("(--start로 끝난 장면은 건너뛰어요):" if start > 0 else ":"),
              f"       {cmd}",
              "       빈 방 보정부터 다시 해요. 같은 --day에 섞으면 보드가 다시 켜지기 전 기준선과 맞지 않아요."]
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--api", default=os.environ.get("WATCHMATE_API", "http://127.0.0.1:8000"))
    ap.add_argument("--no-live", action="store_true")
    ap.add_argument("--calibration-seconds", type=int, default=180, choices=range(20, 601), metavar="20..600")
    ap.add_argument("--max-tau", type=float, default=CAL_MAX_TAU)
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
                say(f"서버 전송이 {DELIVERY_GRACE:.0f}초 넘게 끊겼습니다. 연속 원본을 보존하고 연결이 돌아오면 이 장면을 다시 측정합니다.")
                if measurement:
                    measurement.lost_since = None
                continue
            finished = rec.data["started_at"] + next(iter(saved.values()))[2]
            rec.update(phase="between", phase_started=finished, finished_at=finished,
                       phase_seconds=0.0, message="장면 종료 · 화면 기록 저장 확인 중")
            if measurement:
                measurement.wait_screen(capture)
                if measurement.wants_quiet_check(labels):
                    issues = measurement.quiet_issues(rec.data["started_at"], finished)
                    if issues and measurement.quiet_left > 0:
                        set_aside(saved)
                        measurement.recalibrate(capture, countdown, issues)
                        continue
                    if issues:
                        say(f"  ! 다시 보정을 {QUIET_TRIES}번 했는데도 빈 방에서 흔들려요({', '.join(issues)}). 그대로 진행합니다.\n"
                            "    끝난 뒤 그 보드를 몇 cm 옮기거나 문·의자·전원 상태를 확인하세요.")
                    measurement.quiet_done = True
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
            if measurement:
                measurement.check_restarts()  # 녹화 중이면 장면을 지우고 끝낸다(다시 찍어도 판단할 수 없음)
            if measurement and rec.data["phase"] == "recording" and measurement.recording_stalled():
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
        measurement = Measurement(rec, api, token, site, names, args.calibration_seconds, tee, args.max_tau)
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
    restarted: NodeRestarted | None = None
    stopped_at = ("", -1)  # 멈춘 때의 단계와 장면 번호(이어 찍을 장면을 정한다)
    try:
        col.main(["session", *rest])
    except NodeRestarted as exc:
        restarted = exc
        stopped_at = (rec.data["phase"], rec.data["index"])
        when = "보정 중에" if exc.during_calibration else "보정 뒤에"
        rec.update(phase="stopped", phase_started=time.time(), phase_seconds=0.0,
                   message=f"{exc} 보드가 {when} 다시 켜져 측정을 멈췄어요. 녹화 도우미 창의 안내를 따라 주세요.")
        time.sleep(3)  # 화면이 멈춘 이유를 한 번 받아 가게 둔다
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
    if restarted is not None:
        when = "보정 중에" if restarted.during_calibration else "보정 뒤에"
        say(f"\n  ✗ {restarted} 보드가 {when} 다시 켜졌어요(전원이 잠깐 빠졌을 수 있어요).\n"
            "    보드가 신호 크기 기준을 새로 잡아서, 이번 빈 방 기준선으로는 판단할 수 없어요.\n"
            "    진행 중이던 장면은 지웠고 감지를 닫았어요. 끝난 장면 파일과 연속 원본은 남아 있어요.")
        say(restart_guidance(restarted, stopped_at, plan, rest))
        sys.exit(2)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        say("\n멈췄어요.")
