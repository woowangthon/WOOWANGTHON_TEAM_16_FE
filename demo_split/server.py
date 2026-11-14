"""시연 영상용 분할 화면 서버: 왼쪽 실시간 판정 화면 + 오른쪽 휴대폰 카메라.

- 노트북:  http://localhost:8790           분할 화면(이 화면을 녹화한다). 이 노트북 안에서만 열린다.
- 휴대폰:  https://<노트북 주소>:8791/cam    카메라 영상을 노트북으로 보낸다(같은 와이파이·핫스팟).
  휴대폰 브라우저는 https에서만 카메라를 쓸 수 있어서 이 폴더의 자체 서명 인증서(cert/)를 쓴다.
  처음 열 때 '안전하지 않음' 경고가 나오면 고급 → 계속을 누른다.
- 휴대폰이 JPEG 사진을 초당 10~20장 올리고, 분할 화면이 이어 붙여 보여 준다(소리는 없다).
- 와이파이 쪽(8791)으로 여는 것은 카메라 페이지와 사진 올리기뿐이고, 열쇠(주소의 k=)가 있어야 한다.
- 왼쪽 시연 화면은 판정 서버(8000)의 감지 상태를 1초마다 읽어 그린다(서버·DB는 읽기만 한다).

실행: C:\\wm\\watchmate-be\\.venv\\Scripts\\python.exe C:\\wm\\demo_split\\server.py --open
옵션: --site http://localhost:5173(왼쪽에 사이트를 그대로 띄울 때 주소) · --demo-feed(휴대폰 연결 전 시험 영상)
      --replay [감지번호](실시간 대신 끝난 측정 기록 재생) · --speed 8(재생 배속) · --open(브라우저 열기)
"""
from __future__ import annotations

import argparse
import bisect
import io
import json
import math
import os
import secrets
import socket
import sqlite3
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
MAX_FRAME = 3 * 1024 * 1024  # 사진 한 장 최대 크기
TEST_SOURCE = "시험 영상"


class Frames:
    """가장 최근 사진 한 장과 받은 시각들."""

    def __init__(self) -> None:
        self.cond = threading.Condition()
        self.jpeg: bytes | None = None
        self.seq = 0
        self.at = 0.0
        self.source = ""
        self.real_at = 0.0  # 휴대폰(시험 영상 아님)에서 마지막으로 받은 시각
        self.times: deque[float] = deque(maxlen=60)

    def put(self, data: bytes, source: str) -> None:
        with self.cond:
            now = time.time()
            self.jpeg, self.source, self.at = data, source, now
            self.seq += 1
            self.times.append(now)
            if source != TEST_SOURCE:
                self.real_at = now
            self.cond.notify_all()

    def wait_new(self, last_seq: int, timeout: float) -> tuple[int, bytes | None]:
        with self.cond:
            if self.seq == last_seq:
                self.cond.wait(timeout)
            return self.seq, self.jpeg

    def status(self) -> dict:
        with self.cond:
            now = time.time()
            recent = [t for t in self.times if now - t <= 3.0]
            fps = (len(recent) - 1) / (recent[-1] - recent[0]) if len(recent) >= 2 and recent[-1] > recent[0] else 0.0
            return {"seq": self.seq, "age": None if not self.at else round(now - self.at, 2), "fps": round(fps, 1),
                    "bytes": len(self.jpeg or b""), "source": self.source, "test": self.source == TEST_SOURCE}


FRAMES = Frames()
CFG: dict = {}


def lan_ips() -> list[str]:
    ips: list[str] = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))  # 실제로 보내지는 않는다. 밖으로 나가는 주소만 알아낸다
            ips.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    return [ip for ip in ips if not ip.startswith("127.")]


def cam_urls() -> list[str]:
    return [f"https://{ip}:{CFG['cam_port']}/cam?k={CFG['token']}" for ip in lan_ips()]


SEEN_PHONES: dict = {}


def note_phone(ip: str, what: str) -> None:
    """휴대폰이 어디까지 왔는지 창에 한 번씩만 적는다(연결 문제를 찾을 때 본다)."""
    if (ip, what) not in SEEN_PHONES:
        SEEN_PHONES[(ip, what)] = time.time()
        print(f"  [{time.strftime('%H:%M:%S')}] 휴대폰 {ip}: {what}", flush=True)


# ---------------------------------------------------------------- 왼쪽 시연 화면용 판정 데이터
BE = Path(os.environ.get("WATCHMATE_BE") or r"C:\wm\watchmate-be")
API = os.environ.get("WATCHMATE_API", "http://127.0.0.1:8000").rstrip("/")
SESSIONS = Path(r"C:\wm\data\sessions")
SITE_FLOOR = "S4-1동 2층"
PERSON_KO = {"standing": "사람이 서 있음", "sitting": "사람이 앉아 있음", "lying": "사람이 누워 있음"}
ROOM_KO = {"301": "223호", "302": "224호", "cor": "복도"}
LIVE: dict = {"mode": "live", "snap": {"mode": "live", "ok": False, "note": "판정 서버에 연결하는 중"}, "replay": None}
LIVE_LOCK = threading.Lock()


def read_env(path: Path) -> dict:
    out: dict = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def api(method: str, path: str, token: str | None = None, body: dict | None = None, timeout: float = 4.0):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode())
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read()
    return json.loads(raw) if raw else None


def login() -> str:
    """녹화 도우미와 같은 순서: 환경 변수 → watchmate-be/.env → 서버 기본 계정."""
    env = read_env(BE / ".env")
    user = os.environ.get("WATCHMATE_USER") or env.get("DEMO_USERNAME") or "demo"
    password = os.environ.get("WATCHMATE_PASSWORD") or env.get("DEMO_PASSWORD") or "demo1234"
    return api("POST", "/api/auth/login", body={"username": user, "password": password})["token"]


def epoch(value) -> float:
    dt = datetime.fromisoformat(str(value).replace("T", " "))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


SITE_CACHE: dict = {"mtime": None, "site": None}


def site_profile() -> dict | None:
    """site.json이 있으면 그 장소로 그린다(방 이름·크기·보드 자리). 없으면 등록된 2층 도면 그대로.

    판정 서버에 등록된 공간은 건드리지 않는다. 화면에 보이는 이름과 도면만 바꾼다.
    """
    path = HERE / "site.json"
    try:
        mtime = path.stat().st_mtime
    except OSError:
        SITE_CACHE.update(mtime=None, site=None)
        return None
    if mtime != SITE_CACHE["mtime"]:
        try:
            site = json.loads(path.read_text(encoding="utf-8"))
            ok = isinstance(site, dict) and isinstance(site.get("crop"), dict) and isinstance(site.get("zones"), dict)
        except (OSError, ValueError):
            site, ok = None, False
        if not ok:
            print("  site.json을 읽지 못했어요. 원래 2층 도면으로 보여요.", flush=True)
        SITE_CACHE.update(mtime=mtime, site=site if ok else None)
    return SITE_CACHE["site"]


def room_ko(room: str) -> str:
    site = site_profile()
    board = {"301": "RX-301", "302": "RX-302", "cor": "RX-COR"}.get(room)
    if site and board in site["zones"] and site["zones"][board].get("name"):
        return site["zones"][board]["name"]
    return ROOM_KO.get(room, room)


def truth_text(scene: str) -> str:
    """장면 이름(standing_301 등)을 '실제 상황' 문장으로."""
    if "empty" in scene:
        return "모든 구역이 비어 있음"
    pose, _, room = scene.partition("_")
    return f"{room_ko(room)} · {PERSON_KO.get(pose, pose)}"


def geometry(zones: list, nodes: list) -> tuple[list, list]:
    zs = [{"id": z["id"], "name": z["name"], "polygon": z.get("polygon") or []} for z in zones]
    ns = [{"name": n["name"], "role": n["role"], "x": n.get("x"), "y": n.get("y"), "zone_id": n.get("zone_id")}
          for n in nodes]
    site = site_profile()
    if site:  # 보드 이름(또는 등록된 구역 이름)으로 구역을 찾아 이름과 네모(미터)를 붙인다
        board_zone = {n["name"]: n.get("zone_id") for n in nodes if n.get("role") == "rx"}
        for key, spec in site["zones"].items():
            for z in zs:
                if "rect" not in z and (z["id"] == board_zone.get(key) or z["name"] == key):
                    z["name"] = spec.get("name") or z["name"]
                    z["rect"] = spec.get("rect")
                    break
        for n in ns:
            pos = (site.get("nodes") or {}).get(n["name"])
            if pos:
                n["mx"], n["my"] = pos[0], pos[1]
    return zs, ns


# ---------------------------------------------------------------- 동선 안내(시연할 사람이 볼 단계)
DEFAULT_STEPS = [
    {"text": "밖에서 대기", "truth": "모든 구역이 비어 있음", "seconds": 20},
    {"text": "223호 · 들어가서 서기", "truth": "223호 · 사람이 서 있음", "seconds": 30},
    {"text": "223호 · 앉기", "truth": "223호 · 사람이 앉아 있음", "seconds": 30},
    {"text": "223호 · 눕기", "truth": "223호 · 사람이 누워 있음", "seconds": 40},
    {"text": "복도 · 나와서 서기", "truth": "복도 · 사람이 서 있음", "seconds": 30},
    {"text": "224호 · 들어가서 서기", "truth": "224호 · 사람이 서 있음", "seconds": 30},
    {"text": "224호 · 앉기", "truth": "224호 · 사람이 앉아 있음", "seconds": 30},
    {"text": "224호 · 눕기", "truth": "224호 · 사람이 누워 있음", "seconds": 40},
    {"text": "밖으로 나가기", "truth": "모든 구역이 비어 있음", "seconds": 30},
]
SCN: dict = {"i": -1, "at": 0.0}
SCN_LOCK = threading.Lock()


def scenario_steps() -> list:
    """scenario.json이 있으면 그 단계를 쓴다([{"text": "...", "truth": "...", "seconds": 30}, ...])."""
    path = HERE / "scenario.json"
    try:
        steps = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(steps, list) and steps and all("text" in s for s in steps):
            return steps
    except (OSError, ValueError):
        pass
    return DEFAULT_STEPS


def scenario(do: str = "") -> dict:
    """지금 단계. do: start(처음부터) · next · prev · stop. 단계 시간이 지나면 저절로 다음으로 넘어간다."""
    steps = scenario_steps()
    with SCN_LOCK:
        now = time.time()
        if do == "start":
            SCN.update(i=0, at=now)
        elif do == "stop":
            SCN.update(i=-1, at=0.0)
        elif do == "next" and SCN["i"] >= 0:
            SCN.update(i=SCN["i"] + 1, at=now)
        elif do == "prev" and SCN["i"] >= 0:
            SCN.update(i=max(0, SCN["i"] - 1), at=now)
        while 0 <= SCN["i"] < len(steps) and now - SCN["at"] >= float(steps[SCN["i"]].get("seconds") or 30):
            SCN.update(i=SCN["i"] + 1, at=SCN["at"] + float(steps[SCN["i"]].get("seconds") or 30))
        if SCN["i"] >= len(steps):
            SCN.update(i=-1, at=0.0)
        i = SCN["i"]
        if i < 0:
            return {"running": False, "n": len(steps), "first": steps[0]["text"]}
        secs = float(steps[i].get("seconds") or 30)
        return {"running": True, "i": i, "n": len(steps), "text": steps[i]["text"], "truth": steps[i].get("truth"),
                "remain": max(0.0, round(secs - (now - SCN["at"]), 1)), "seconds": secs,
                "next": steps[i + 1]["text"] if i + 1 < len(steps) else "끝"}


def recorder_truth() -> str | None:
    """녹화 도우미가 돌고 있으면 지금 장면을 '실제 상황'으로 쓴다."""
    try:
        with urllib.request.urlopen("http://127.0.0.1:8765/rec/scene", timeout=0.4) as res:
            rec = json.load(res)
    except (OSError, ValueError):
        return None
    if not rec.get("running") or not rec.get("scene"):
        return None
    return truth_text(rec["scene"]) if rec.get("phase") == "recording" else "이동 중"


def live_loop() -> None:
    token, site_id, detail, detail_at = None, None, None, 0.0
    since: dict = {}  # 구역마다 (지금 상태, 그 상태가 시작된 시각)
    while True:
        if LIVE["mode"] != "live":
            time.sleep(0.5)
            continue
        snap: dict = {"mode": "live", "ok": True, "active": False, "t": time.time()}
        try:
            if token is None:
                token = login()
            now = time.time()
            if detail is None or now - detail_at > 3:
                if site_id is None:
                    site = next((b for b in api("GET", "/api/buildings", token)
                                 if b.get("floor_label") == SITE_FLOOR and not b.get("is_demo")), None)
                    site_id = site["id"] if site else None
                detail = api("GET", f"/api/buildings/{site_id}", token) if site_id else None
                detail_at = now
            if not detail:
                snap.update(ok=False, note="실험 공간이 아직 등록되지 않았어요")
            else:
                zs, ns = geometry(detail["zones"], detail["nodes"])
                inc = detail.get("active_incident")
                cal = (detail.get("calibration") or {}).get("status")
                snap.update(zones=[{**z, "state": "idle", "p": None, "since": None} for z in zs], nodes=ns,
                            note="빈 방 보정 중" if cal == "running" else "감지 대기 중")
                if inc:
                    st = api("GET", f"/api/incidents/{inc['id']}/state", token)
                    by = {z["id"]: z for z in st["zones"]}
                    t_now = epoch(st["server_time"])
                    for zid, z in by.items():  # 상태가 바뀐 시각을 직접 적어 둔다(있음·없음 모두 '몇 초째'를 보이려고)
                        if zid not in since or since[zid][0] != z["state"]:
                            since[zid] = (z["state"], t_now)
                    snap.update(active=True, t=t_now, thresholds=st.get("thresholds"), note="실시간 감지 중",
                                zones=[{**z, "state": by[z["id"]]["state"], "p": by[z["id"]].get("p"),
                                        "since": since[z["id"]][1]} for z in zs if z["id"] in by])
                    scn = scenario()
                    snap["truth"] = scn.get("truth") if scn["running"] else recorder_truth()
                else:
                    since.clear()
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                token = None
            snap = {"mode": "live", "ok": False, "note": f"판정 서버 응답 오류({exc.code})"}
        except (urllib.error.URLError, OSError, ValueError, KeyError):
            detail = None
            snap = {"mode": "live", "ok": False, "note": "판정 서버(8000)가 꺼져 있어요"}
        if LIVE["mode"] == "live":
            LIVE["snap"] = snap
        time.sleep(0.5)  # 서버는 2초 창마다 새 판정을 낸다. 나오는 대로 바로 보이게 자주 읽는다


def load_replay(incident_id: int, speed: float) -> dict:
    """끝난 측정 하나를 DB에서 한 번만 읽어 재생용으로 준비한다(읽기만 함)."""
    token = login()
    st = api("GET", f"/api/incidents/{incident_id}/state", token, timeout=15)
    zs, ns = geometry(st["zones"], st["nodes"])
    th = st.get("thresholds") or {"detected": 0.5, "possible": 0.2}
    node_ids = {z["id"]: z.get("node_ids") or [] for z in st["zones"]}
    db = BE / "data" / "app.db"
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True, timeout=10)
    try:
        rows = con.execute("select node_id, t, p_change, p_person, quality from inferences "
                           "where incident_id = ? order by t", (incident_id,)).fetchall()
    finally:
        con.close()
    series: dict = {}
    ema: dict = {}
    for nid, t, pc, pp, q in rows:
        p = pp if pp is not None else pc
        if p is None or (q is not None and q < 0.7):
            continue
        ema[nid] = p if nid not in ema else 0.5 * p + 0.5 * ema[nid]
        series.setdefault(nid, ([], []))
        series[nid][0].append(epoch(t))
        series[nid][1].append(ema[nid])
    if not series:
        raise ValueError("이 측정에는 판정 기록이 없어요")
    tracks = {}
    for z in zs:
        nid = next((n for n in node_ids[z["id"]] if n in series), None)
        if nid is None:
            continue
        ts, ps = series[nid]
        states = ["detected" if p >= th["detected"] else "possible" if p >= th["possible"] else "not_detected" for p in ps]
        since, cur = [], 0
        for i, state in enumerate(states):
            if i and state != states[i - 1]:
                cur = i
            since.append(ts[cur])
        tracks[z["id"]] = (ts, ps, states, since)
    t0 = min(tr[0][0] for tr in tracks.values())
    t1 = max(tr[0][-1] for tr in tracks.values())
    scenes = {}
    for p in SESSIONS.glob("*/*.json"):
        try:
            m = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if "scene" in m and "started_at" in m and t0 - 60 <= m["started_at"] <= t1:
            scenes[round(m["started_at"])] = (m["started_at"], m["started_at"] + float(m.get("seconds") or 0), m["scene"])
    d0 = datetime.fromtimestamp(t0)
    return {"incident": incident_id, "speed": speed, "zones": zs, "nodes": ns, "thresholds": th, "tracks": tracks,
            "t0": t0, "t1": t1, "scenes": sorted(scenes.values()), "started": time.time(),
            "label": f"{d0.month}/{d0.day} {d0:%H:%M} 측정 기록"}


def replay_snap() -> dict:
    rp = LIVE["replay"]
    dur = max(1.0, rp["t1"] - rp["t0"])
    vt = rp["t0"] + ((time.time() - rp["started"]) * rp["speed"]) % dur
    zones = []
    for z in rp["zones"]:
        tr = rp["tracks"].get(z["id"])
        if not tr:
            zones.append({**z, "state": "idle", "p": None, "since": None})
            continue
        i = max(0, bisect.bisect_right(tr[0], vt) - 1)
        zones.append({**z, "state": tr[2][i], "p": round(tr[1][i], 4), "since": tr[3][i]})
    sc = next((s for s in rp["scenes"] if s[0] <= vt <= s[1]), None)
    truth = truth_text(sc[2]) if sc else ("이동 중" if rp["scenes"] else None)
    return {"mode": "replay", "ok": True, "active": True, "t": vt, "zones": zones, "nodes": rp["nodes"],
            "thresholds": rp["thresholds"], "truth": truth, "progress": (vt - rp["t0"]) / dur,
            "note": f"기록 재생 · {rp['label']} · {rp['speed']:g}배속"}


def set_mode(mode: str, incident: int | None = None, speed: float = 8.0) -> dict:
    with LIVE_LOCK:
        if mode != "replay":
            LIVE["mode"], LIVE["replay"] = "live", None
            LIVE["snap"] = {"mode": "live", "ok": False, "note": "판정 서버에 연결하는 중"}
            return {"ok": True, "mode": "live"}
        try:
            if incident is None:  # 판정 기록이 충분한 끝난 실측 중 가장 최근 것
                con = sqlite3.connect(f"file:{(BE / 'data' / 'app.db').as_posix()}?mode=ro", uri=True, timeout=10)
                try:
                    row = con.execute("select i.id from incidents i join inferences f on f.incident_id = i.id "
                                      "where i.source = 'measurement' and i.status = 'closed' group by i.id "
                                      "having count(*) > 600 order by i.id desc limit 1").fetchone()
                finally:
                    con.close()
                if not row:
                    return {"ok": False, "note": "재생할 측정 기록이 없어요"}
                incident = row[0]
            LIVE["replay"] = load_replay(incident, speed)
        except (OSError, ValueError, KeyError, sqlite3.Error, urllib.error.URLError) as exc:
            return {"ok": False, "note": f"기록을 읽지 못했어요: {exc}"}
        LIVE["mode"] = "replay"
        return {"ok": True, "mode": "replay", "incident": incident}


def current_live() -> dict:
    snap = replay_snap() if LIVE["mode"] == "replay" and LIVE["replay"] else LIVE["snap"]
    site = site_profile()
    if site and snap.get("zones"):
        return {**snap, "site": {k: site.get(k) for k in ("label", "crop", "rooms", "corridors")}}
    return snap


# ---------------------------------------------------------------- 웹 서버
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # 휴대폰이 연결 하나로 사진을 계속 올리게 한다
    local = True  # 노트북 안쪽(8790)이면 True, 와이파이 쪽(8791)이면 False

    def setup(self) -> None:
        super().setup()
        self.request.settimeout(20)

    def log_message(self, *args) -> None:  # 사진마다 한 줄씩 찍히지 않게
        pass

    def send_body(self, code: int, body: bytes, ctype: str = "text/plain; charset=utf-8") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj) -> None:
        self.send_body(200, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def send_file(self, name: str) -> None:
        self.send_body(200, (HERE / name).read_bytes(), "text/html; charset=utf-8")

    def key_ok(self, query: dict) -> bool:
        return self.local or secrets.compare_digest(query.get("k", [""])[0], CFG["token"])

    def do_GET(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        query = parse_qs(url.query)
        path = url.path
        if path == "/live.json":  # 휴대폰 화면의 실시간 판정 도면(찍는 사람이 같이 본다)
            if not self.key_ok(query):
                self.send_body(403, b"bad key")
                return
            self.send_json(current_live())
            return
        if path == "/guide.json":  # 휴대폰 화면의 '지금 할 일'
            if not self.key_ok(query):
                self.send_body(403, b"bad key")
                return
            self.send_json(scenario())
            return
        if path == "/cam":
            if not self.key_ok(query):
                self.send_body(403, "노트북 분할 화면에 나온 QR이나 주소로 다시 열어 주세요.".encode("utf-8"))
                return
            if not self.local:
                note_phone(self.client_address[0], "카메라 페이지를 열었어요")
            self.send_file("cam.html")
            return
        if not self.local:
            self.send_body(404, "여기는 휴대폰 카메라용 주소예요. 노트북 화면의 QR로 열어 주세요.".encode("utf-8"))
            return
        if path == "/":
            self.send_file("viewer.html")
        elif path == "/info":
            self.send_json({"site": CFG["site"], "cam_urls": cam_urls(),
                            "test_cam": f"http://localhost:{CFG['port']}/cam?test=1"})
        elif path == "/live":
            self.send_json({**current_live(), "scenario": scenario()})
        elif path == "/scenario":
            self.send_json(scenario(query.get("do", [""])[0]))
        elif path == "/mode":
            inc = query.get("incident", [""])[0]
            try:
                speed = min(60.0, max(1.0, float(query.get("speed", ["8"])[0])))
            except ValueError:
                speed = 8.0
            self.send_json(set_mode(query.get("m", ["live"])[0], int(inc) if inc.isdigit() else None, speed))
        elif path == "/status":
            self.send_json(FRAMES.status())
        elif path == "/frame.jpg":
            _, jpeg = FRAMES.wait_new(-1, 0)
            if jpeg is None:
                self.send_body(404, "아직 받은 영상이 없어요.".encode("utf-8"))
            else:
                self.send_body(200, jpeg, "image/jpeg")
        elif path == "/stream.mjpg":
            self.stream()
        else:
            self.send_body(404, b"not found")

    def stream(self) -> None:
        """사진을 받는 대로 이어 보낸다(multipart). 사진 끝에 바로 다음 경계를 붙여 받자마자 그려지게 한다."""
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        last = -1
        try:
            self.wfile.write(b"--frame\r\n")
            while True:
                seq, jpeg = FRAMES.wait_new(last, 1.0)
                if seq == last or jpeg is None:
                    continue
                last = seq
                self.wfile.write(b"Content-Type: image/jpeg\r\nContent-Length: " + str(len(jpeg)).encode()
                                 + b"\r\n\r\n" + jpeg + b"\r\n--frame\r\n")
                self.wfile.flush()
        except OSError:
            pass  # 화면이 닫혔다

    def do_POST(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        if url.path != "/frame":
            self.send_body(404, b"not found")
            return
        if not self.key_ok(parse_qs(url.query)):
            self.send_body(403, b"bad key")
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if not 0 < size <= MAX_FRAME:
            self.close_connection = True
            self.send_body(413, b"bad size")
            return
        data = self.rfile.read(size)
        if len(data) != size or data[:2] != b"\xff\xd8":
            self.send_body(415, b"jpeg only")
            return
        if not self.local:
            note_phone(self.client_address[0], "영상이 들어오기 시작했어요")
        FRAMES.put(data, "시험 페이지" if self.local else f"휴대폰 {self.client_address[0]}")
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()


class CamHandler(Handler):
    local = False


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        exc = sys.exc_info()[1]
        if isinstance(exc, ssl.SSLError):
            note_phone(client_address[0], "연결은 됐지만 보안 경고 화면에서 멈췄어요(고급 → 계속을 눌러야 해요)")
            return
        if isinstance(exc, OSError):
            return  # 끊긴 연결 등은 조용히 넘긴다
        super().handle_error(request, client_address)


def demo_feed() -> None:
    """휴대폰이 연결되기 전에 오른쪽 칸이 어떻게 보이는지 알 수 있게 시험 영상을 만든다(휴대폰 영상이 오면 멈춘다)."""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        print("시험 영상은 Pillow가 있어야 해요. 건너뜁니다.", flush=True)
        return
    try:
        big = ImageFont.truetype(r"C:\Windows\Fonts\malgunbd.ttf", 34)
        small = ImageFont.truetype(r"C:\Windows\Fonts\malgun.ttf", 24)
    except OSError:
        big = small = ImageFont.load_default()
    w, h = 540, 960
    t0 = time.time()
    while True:
        if time.time() - FRAMES.real_at < 5:  # 진짜 휴대폰 영상이 오는 동안은 쉰다
            time.sleep(0.5)
            continue
        t = time.time() - t0
        img = Image.new("RGB", (w, h), (27, 29, 34))
        d = ImageDraw.Draw(img)
        d.rectangle([0, 640, w, h], fill=(38, 41, 48))                      # 바닥
        d.rectangle([60, 250, 200, 640], outline=(70, 74, 84), width=3)     # 문
        d.rectangle([330, 430, 500, 640], outline=(70, 74, 84), width=3)    # 책상
        x = w / 2 + 70 * math.sin(t * 0.7)                                  # 천천히 좌우로 움직이는 사람 모양
        d.ellipse([x - 34, 330, x + 34, 398], fill=(232, 198, 160))
        d.rounded_rectangle([x - 52, 404, x + 52, 600], radius=24, fill=(57, 135, 229))
        d.rectangle([x - 40, 600, x - 8, 700], fill=(52, 58, 70))
        d.rectangle([x + 8, 600, x + 40, 700], fill=(52, 58, 70))
        d.text((w / 2, 70), "시험 영상", font=big, fill=(240, 239, 236), anchor="mm")
        d.text((w / 2, 116), "휴대폰을 연결하면 카메라로 바뀌어요", font=small, fill=(163, 162, 155), anchor="mm")
        d.text((w / 2, 900), time.strftime("%H:%M:%S") + f".{int(time.time() * 10) % 10}", font=small,
               fill=(163, 162, 155), anchor="mm")
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=80)
        FRAMES.put(buf.getvalue(), TEST_SOURCE)
        time.sleep(1 / 12)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="시연 영상용 분할 화면(판정 화면 + 휴대폰 카메라)")
    ap.add_argument("--site", default="http://localhost:5173", help="왼쪽에 사이트를 그대로 띄울 때의 주소")
    ap.add_argument("--port", type=int, default=8790, help="분할 화면 포트(노트북 안에서만)")
    ap.add_argument("--cam-port", type=int, default=8791, help="휴대폰 카메라 포트(https, 와이파이로 열림)")
    ap.add_argument("--demo-feed", action="store_true", help="휴대폰 연결 전 시험 영상을 보여 준다")
    ap.add_argument("--replay", nargs="?", const="latest", default=None, metavar="감지번호",
                    help="실시간 대신 끝난 측정 기록을 재생한다(번호를 안 주면 가장 최근 측정)")
    ap.add_argument("--speed", type=float, default=8.0, help="기록 재생 배속(기본 8)")
    ap.add_argument("--open", action="store_true", help="시작하면 분할 화면을 기본 브라우저로 연다")
    args = ap.parse_args()
    key_file = HERE / "cert" / "phone_key.txt"  # 다시 켜도 휴대폰 주소(QR)가 그대로이게 열쇠를 남겨 둔다
    key_file.parent.mkdir(exist_ok=True)
    if not key_file.exists():
        key_file.write_text(secrets.token_urlsafe(9), encoding="ascii")
    CFG.update(site=args.site, port=args.port, cam_port=args.cam_port,
               token=key_file.read_text(encoding="ascii").strip())

    cert, key = HERE / "cert" / "cert.pem", HERE / "cert" / "key.pem"
    if not cert.exists() or not key.exists():
        sys.exit(f"인증서 파일이 없어요: {cert} · README의 '처음 받았을 때'에 있는 openssl 명령으로 한 번 만들어 주세요.")
    local = QuietServer(("127.0.0.1", args.port), Handler)
    cam = QuietServer(("0.0.0.0", args.cam_port), CamHandler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    # 악수는 연결마다 그 연결의 스레드에서 한다(인증서 경고 화면에 멈춘 휴대폰이 다른 연결을 막지 않게)
    cam.socket = ctx.wrap_socket(cam.socket, server_side=True, do_handshake_on_connect=False)
    threading.Thread(target=cam.serve_forever, daemon=True).start()
    threading.Thread(target=live_loop, daemon=True).start()
    if args.demo_feed:
        threading.Thread(target=demo_feed, daemon=True).start()

    print(f"시연 분할 화면(노트북 크롬에서 열기): http://localhost:{args.port}", flush=True)
    urls = cam_urls()
    if urls:
        print("휴대폰 카메라 주소(분할 화면의 QR로 열면 편해요. 와이파이를 바꾸면 QR도 바뀌어요):", flush=True)
        for u in urls:
            print("  " + u, flush=True)
    else:
        print("와이파이 주소를 찾지 못했어요. 노트북이 와이파이나 핫스팟에 연결돼 있는지 확인하세요.", flush=True)
    if args.replay:
        res = set_mode("replay", int(args.replay) if args.replay.isdigit() else None, args.speed)
        print("기록 재생: " + (f"감지 {res.get('incident')}번을 재생해요" if res.get("ok") else res.get("note", "실패")),
              flush=True)
    print("끄려면 Ctrl+C", flush=True)
    if args.open:
        webbrowser.open(f"http://localhost:{args.port}")
    try:
        local.serve_forever()
    except KeyboardInterrupt:
        print("\n껐어요.", flush=True)


if __name__ == "__main__":
    main()
