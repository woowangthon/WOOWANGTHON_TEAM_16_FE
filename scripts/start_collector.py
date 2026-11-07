"""와치메이트 수집기 자동 실행 도우미.

게이트웨이(5번)를 노트북 USB에 꽂고 실행하면 차례대로:
  1) 서버가 켜져 있는지 봐요.
  2) 게이트웨이 USB 포트를 스스로 찾아요(COM 번호를 몰라도 돼요).
  3) TX-1과 수신기(RX-301·RX-302·RX-COR)가 신호를 보내는지 점검하고, 안 되는 보드와 고칠 점을 알려 줘요.
  4) 서버에서 수신기 토큰을 새로 받아요. 토큰은 화면에 찍지 않고 이 프로그램 안에서만 써요.
  5) 수집기(watchmate-be/tools/collector.py live)를 이어서 실행해요. 멈출 때는 Ctrl+C.

실행: start-collector.bat 을 두 번 누르거나
  C:\\wm\\watchmate-be\\.venv\\Scripts\\python C:\\wm\\watchmate-fe\\scripts\\start_collector.py
옵션: --check(점검만), --seconds 8(점검 시간), --api http://127.0.0.1:8000
환경 변수: WATCHMATE_BE(백엔드 폴더), WATCHMATE_API, WATCHMATE_USER, WATCHMATE_PASSWORD
"""

from __future__ import annotations

import argparse
import getpass
import importlib.util
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve()
BE = Path(os.environ.get("WATCHMATE_BE") or HERE.parents[2] / "watchmate-be")
SITE_FLOOR = "S4-1동 2층"
LOSS_WARN = 0.30  # 이보다 많이 잃으면 게이트웨이 자리를 옮겨 보라고 한다
RATE_WARN = 20.0  # TX-1은 초당 약 100개를 보낸다. 이보다 적게 받으면 판정이 흔들린다


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


# ---- 1) 서버 -----------------------------------------------------------------
def check_server(api: str) -> dict:
    try:
        return http("GET", f"{api}/api/health", timeout=60)
    except (urllib.error.URLError, TimeoutError, OSError):
        say(f"  ✗ 서버({api})에 연결할 수 없어요.")
        say("    서버를 먼저 켜 주세요: cd C:\\wm\\watchmate-be; .\\.venv\\Scripts\\python -m uvicorn app.main:app --port 8000")
        sys.exit(1)


# ---- 2) 게이트웨이 포트 찾기 ----------------------------------------------------
def find_gateway(col, wait: float = 4.0) -> tuple[str | None, str, list[str]]:
    """게이트웨이 상태 묶음(또는 CSI 묶음)이 오는 포트를 찾는다. 블루투스 포트는 건너뛴다."""
    import serial  # type: ignore
    from serial.tools import list_ports  # type: ignore

    ports = [p for p in list_ports.comports() if "bluetooth" not in (p.description or "").lower()]
    ports.sort(key=lambda p: 0 if "CH34" in (p.description or "") else 1)
    busy: list[str] = []
    for p in ports:
        try:
            ser = serial.Serial(p.device, col.GW_BAUD, timeout=0.2)
        except serial.SerialException:
            busy.append(p.device)
            continue
        reader = col.GatewayFrameReader()
        status, saw_csi = "", False
        t0 = time.time()
        try:
            while time.time() - t0 < wait and not status:
                for ftype, payload in reader.feed(ser.read(4096)):
                    if ftype == col.GW_TYPE_STATUS:
                        status = payload.decode("utf-8", errors="replace")
                    elif ftype == col.GW_TYPE_CSI:
                        saw_csi = True
                if saw_csi and time.time() - t0 > 1.5:
                    break
        finally:
            ser.close()
        if status or saw_csi:
            return p.device, status, busy
    return None, "", busy


# ---- 3) 보드 점검 -------------------------------------------------------------
def check_boards(col, port: str, seconds: float) -> tuple[str, dict[str, dict]]:
    hub = col._GatewayHub.get(port, col.GW_BAUD)
    try:
        start = {mac: (st.frames, st.lost, st.resets) for mac, st in hub.stats.items()}
        time.sleep(seconds)
        status = hub.status
        rows: dict[str, dict] = {}
        for mac, st in hub.stats.items():
            f0, l0, r0 = start.get(mac, (0, 0, 0))
            got, lost = st.frames - f0, st.lost - l0
            if got == 0:
                continue
            rows[mac] = {
                "hz": got / seconds,
                "loss": lost / max(got + lost, 1),
                "rssi": statistics.fmean(st.gw_rssi) if st.gw_rssi else float("nan"),
                "resets": st.resets - r0,
            }
    finally:
        hub.release()
    return status, rows


def report_boards(names: dict[str, str], rows: dict[str, dict]) -> list[str]:
    """보드마다 상태와 고칠 점을 말한다. 들어오는 수신기 이름 목록을 돌려준다."""
    mac_to_name = {m: n for n, m in names.items()}
    ok: list[str] = []
    if rows:
        say("  ✓ TX-1      켜져 있어요 (수신기가 TX-1 신호로 측정값을 만들고 있어요)")
    else:
        say("  ✗ TX-1      알 수 없어요. 들어오는 수신기가 하나도 없어서 TX-1이 꺼졌는지, 수신기가 모두 꺼졌는지 구분이 안 돼요.")
    for name, mac in sorted(names.items()):
        r = rows.get(mac)
        if r is None:
            say(f"  ✗ {name:<9} 안 들어와요 → 전원이 켜졌는지, 게이트웨이에서 너무 멀거나 벽 너머인지 확인하세요.")
            continue
        ok.append(name)
        tips = []
        if r["loss"] > LOSS_WARN:
            tips.append(f"잃는 비율이 커요({r['loss']:.0%}). 게이트웨이를 이 보드 쪽으로 옮기거나 사이 문을 열어 보세요.")
        if r["hz"] < RATE_WARN:
            tips.append("초당 받는 수가 적어요. TX-1과의 거리·전원을 확인하세요.")
        if r["resets"]:
            tips.append("점검 중에 다시 켜졌어요. 케이블·보조배터리를 확인하고, 보정을 다시 해야 해요.")
        mark = "!" if tips else "✓"
        say(f"  {mark} {name:<9} 들어와요 · 초당 {r['hz']:.0f}개 · 잃음 {r['loss']:.0%} · 신호 {r['rssi']:.0f} dBm")
        for t in tips:
            say(f"      → {t}")
    unknown = [m for m in rows if m not in mac_to_name]
    if unknown:
        say(f"  ? 이름표가 없는 보드가 있어요: {', '.join(unknown)} → watchmate-be/nodes.csv에 적어 주세요.")
    return ok


# ---- 4) 토큰 -----------------------------------------------------------------
def login(api: str, interactive: bool) -> str:
    env = read_env_file(BE / ".env")
    user = os.environ.get("WATCHMATE_USER") or env.get("DEMO_USERNAME") or "demo"
    password = os.environ.get("WATCHMATE_PASSWORD") or env.get("DEMO_PASSWORD") or "demo1234"
    for attempt in range(2):
        try:
            return http("POST", f"{api}/api/auth/login", body={"username": user, "password": password})["token"]
        except urllib.error.HTTPError as exc:
            if exc.code != 401 or attempt or not interactive:
                raise
            password = getpass.getpass(f"  서버 로그인 비밀번호({user})를 입력하세요(화면에 안 보여요): ")
    raise RuntimeError("로그인하지 못했어요.")


def prepare_tokens(api: str, interactive: bool) -> tuple[dict, dict[str, str]]:
    tok = login(api, interactive)
    buildings = http("GET", f"{api}/api/buildings", tok)
    site = next((b for b in buildings if b.get("floor_label") == SITE_FLOOR and not b.get("is_demo")), None)
    if site is None:
        say("  ✗ 실험 공간이 아직 없어요. 화면 '실험 진행' 2단계에서 '실험 공간 등록하기'를 먼저 눌러 주세요.")
        sys.exit(1)
    detail = http("GET", f"{api}/api/buildings/{site['id']}", tok)
    tokens: dict[str, str] = {}
    for n in detail["nodes"]:
        if n["role"] == "rx":
            tokens[n["name"]] = http("POST", f"{api}/api/nodes/{n['id']}/token", tok)["token"]
    return site, tokens


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="와치메이트 수집기 자동 실행 도우미")
    ap.add_argument("--api", default=os.environ.get("WATCHMATE_API", "http://127.0.0.1:8000"))
    ap.add_argument("--seconds", type=float, default=8)
    ap.add_argument("--check", action="store_true", help="점검만 하고 수집기는 켜지 않아요")
    args = ap.parse_args()
    api = args.api.rstrip("/")

    say("와치메이트 수집기 자동 실행")
    say("1) 서버 확인")
    health = check_server(api)
    mode = "사람 판별 모델 사용" if health.get("mode") == "person" else "모델 미연결 · 신호 변화만 판단"
    say(f"  ✓ 켜져 있어요 ({api}, {mode})")

    col = load_collector()
    say("2) 게이트웨이 찾기")
    port, status, busy = find_gateway(col)
    if port is None:
        if busy:
            say(f"  ✗ {', '.join(busy)} 포트를 다른 프로그램이 쓰고 있어요. 이미 켜 둔 수집기 창이 있으면 Ctrl+C로 끄고 다시 실행하세요.")
        else:
            say("  ✗ 게이트웨이를 찾지 못했어요. 게이트웨이(5번)를 노트북 USB에 꽂았는지, 케이블이 데이터용인지 확인하세요.")
        sys.exit(1)
    gw_name = status.split(" up ")[0] if status else ""
    say(f"  ✓ {port}에서 찾았어요" + (f" ({gw_name})" if gw_name else ""))

    say(f"3) 보드 점검 ({args.seconds:.0f}초)")
    _, rows = check_boards(col, port, args.seconds)
    names = col.load_node_names()
    ok = report_boards(names, rows)
    if args.check:
        say("\n점검만 했어요(--check). 수집기를 켜려면 옵션 없이 다시 실행하세요.")
        return

    say("4) 수신기 토큰 준비")
    try:
        site, tokens = prepare_tokens(api, sys.stdin.isatty())
    except urllib.error.HTTPError as exc:
        say(f"  ✗ 서버가 거절했어요({exc.code}). 로그인 정보(WATCHMATE_USER·WATCHMATE_PASSWORD)를 확인하세요.")
        sys.exit(1)
    usable = [n for n in tokens if n in names]
    if not usable:
        say("  ✗ 서버에 등록된 수신기 이름이 nodes.csv에 없어요. 이름표를 맞춰 주세요.")
        sys.exit(1)
    say(f"  ✓ {site['name']} · 수신기 {len(usable)}대 토큰을 새로 받았어요(화면에는 안 보여요)")

    say("5) 수집기 시작")
    waiting = [n for n in usable if n not in ok]
    say(f"  지금 들어오는 보드: {', '.join(ok) if ok else '없음'}" + (f" · 켜지면 자동으로 들어올 보드: {', '.join(waiting)}" if waiting else ""))
    say("  이 창은 켜 둔 채로 두세요. 멈추려면 Ctrl+C.\n")
    argv = ["live", "--gateway", port, "--api", api]
    for name in usable:
        argv += ["--port", f"gw:{name}", "--token", tokens[name]]
    col.main(argv)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        say("\n수집기를 멈췄어요.")
