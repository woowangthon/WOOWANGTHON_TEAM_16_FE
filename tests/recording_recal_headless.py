"""첫 빈 방 점검 → 다시 보정 흐름을 브라우저 없이 보는 로컬 종단 시험(playwright가 없는 노트북용).

가짜 USB 입력(recording_browser.py simulate)·실제 FastAPI 서버·실제 녹화 도우미를 쓰고, 화면 대신 이 스크립트가
실험 공간을 등록하고 도우미의 단계마다 확인(/rec/ack)을 보낸다. 화면이 새 감지를 따라가는지는
recording_recal_browser.py(브라우저)로 본다. 가짜 신호는 흔들리지 않으므로 WATCHMATE_FORCE_RECAL=1로 첫 점검만 걸리게 한다.
확인: 첫 빈 방 뒤 다시 보정(새 감지) → 빈 방 다시 녹화 → 끝까지(종료 코드 0), 남은 장면 파일 6개,
처음 빈 방 파일 3쌍은 excluded_recal로 옮김, 감지 모두 닫힘.
실행: C:\\wm\\watchmate-be\\.venv\\Scripts\\python.exe C:\\wm\\watchmate-fe\\tests\\recording_recal_headless.py
"""

import csv
import json
import os
from pathlib import Path
import socket
import sysconfig
import subprocess
import sys
import tempfile
import time
import urllib.request

FE = Path(__file__).resolve().parents[1]
BE = FE.parent / "watchmate-be"
SIM = FE / "tests" / "recording_browser.py"
NODES = ["RX-301", "RX-302", "RX-COR"]
PASS_MODE = "--pass" in sys.argv  # 점검을 통과하는 평소 흐름(다시 보정 없음)을 본다
ZONES = {"RX-301": "223호", "RX-302": "224호", "RX-COR": "복도"}


def available_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def call(method, url, token=None, body=None, timeout=10):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read()
    return json.loads(raw) if raw else None


def register_site(api):
    """화면 2단계 '실험 공간 등록'과 같은 것을 API로 만든다."""
    token = call("POST", api + "/api/auth/login", body={"username": "demo", "password": "demo1234"})["token"]
    b = call("POST", api + "/api/buildings", token, {"name": "S4-1동 2층 실험", "address": "", "floor_label": "S4-1동 2층"})
    zone_ids = {}
    for i, name in enumerate(("223호", "224호", "복도")):
        x0, x1 = i / 3, (i + 1) / 3
        zone_ids[name] = call("POST", f"{api}/api/buildings/{b['id']}/zones", token,
                              {"name": name, "polygon": [[x0, 0], [x1, 0], [x1, 1], [x0, 1]]})["id"]
    call("POST", f"{api}/api/buildings/{b['id']}/nodes", token,
         {"name": "TX-1", "role": "tx", "x": 0.5, "y": 0.1, "zone_id": None})
    for i, n in enumerate(NODES):
        call("POST", f"{api}/api/buildings/{b['id']}/nodes", token,
             {"name": n, "role": "rx", "x": (i + 0.5) / 3, "y": 0.5, "zone_id": zone_ids[ZONES[n]]})
    return token, b["id"]


def run():
    api_port, rec_port = available_port(), available_port()
    api, rec_url = f"http://127.0.0.1:{api_port}", f"http://127.0.0.1:{rec_port}"
    with tempfile.TemporaryDirectory(prefix="watchmate-recal-") as tmp:
        work = Path(tmp)
        plan = work / "plan.csv"
        with plan.open("w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["scene", "description", "people", "seconds", *NODES])
            w.writerow(["start_empty", "빈 방", 0, 12, "empty", "empty", "empty"])
            w.writerow(["walk", "복도 걷기", 1, 4, "neighbor", "neighbor", "walking"])
        env = dict(os.environ, PYTHONPATH=sysconfig.get_path("purelib"), DATABASE_URL="sqlite:///" + (work / "test.db").as_posix(),
                   WATCHMATE_API=api, WATCHMATE_REC_PORT=str(rec_port), PYTHONUTF8="1", PYTHONUNBUFFERED="1",
                   WATCHMATE_FORCE_RECAL="0" if PASS_MODE else "1")
        procs = []
        log_path = work / "run.log"
        with log_path.open("w", encoding="utf-8") as log:
            def start(args):
                p = subprocess.Popen(args, cwd=BE, env=env, stdout=log, stderr=log)
                procs.append(p)
                return p

            try:
                start([sys._base_executable, "-m", "uvicorn", "app.main:app", "--port", str(api_port), "--no-access-log"])
                for _ in range(120):
                    try:
                        call("GET", api + "/api/health", timeout=1)
                        break
                    except OSError:
                        time.sleep(0.25)
                else:
                    raise RuntimeError("server did not start")
                token, building_id = register_site(api)
                recorder = start([sys._base_executable, str(SIM), "simulate", "--plan", str(plan), "--out", str(work / "data"),
                                  "--day", "synthetic", "--countdown", "0", "--calibration-seconds", "22",
                                  *(opt for n in NODES for opt in ("--node", n + "=sim"))])
                seen, acked = [], None
                deadline = time.monotonic() + 300
                while recorder.poll() is None and time.monotonic() < deadline:
                    try:
                        st = call("GET", rec_url + "/rec/scene", timeout=2)
                    except OSError:
                        time.sleep(0.2)
                        continue
                    key = (st.get("run_id"), st.get("version"))
                    if st.get("run_id"):  # 화면처럼 폴링할 때마다 지금 단계를 확인한다(보고 있다는 신호)
                        try:
                            call("POST", rec_url + "/rec/ack", body={"run_id": key[0], "version": key[1]}, timeout=2)
                            acked = key
                        except OSError:
                            pass
                    step = (st.get("phase"), st.get("scene"), st.get("incident_id"))
                    if not seen or seen[-1] != step:
                        seen.append(step)
                    time.sleep(0.2)
                assert recorder.poll() == 0, f"recorder exit {recorder.poll()}, steps {seen}"
                if PASS_MODE:
                    log.flush()
                    text = log_path.read_text("utf-8", errors="replace")
                    rec_steps = [s for s in seen if s[0] == "recording"]
                    assert [s[1] for s in rec_steps] == ["start_empty", "walk"], rec_steps
                    assert "첫 빈 방 점검" in text and "통과" in text and "다시 잡습니다" not in text
                    assert len(list((work / "data").glob("*.json"))) == 6 and not (work / "data" / "excluded_recal").exists()
                    print("PASS(평소 흐름): 첫 빈 방 점검 통과 → 다시 보정 없이 끝까지 진행")
                    print([line for line in text.splitlines() if "첫 빈 방 점검" in line][0])
                    return
                rec_steps = [s for s in seen if s[0] == "recording"]
                assert len(rec_steps) >= 3 and rec_steps[0][1] == rec_steps[1][1] == "start_empty", rec_steps
                first_inc, second_inc = rec_steps[0][2], rec_steps[1][2]
                assert first_inc and second_inc and first_inc != second_inc, rec_steps
                i_first = seen.index(rec_steps[0])
                assert any(s[0] == "calibrating" for s in seen[i_first:seen.index(rec_steps[1])]), seen
                data = work / "data"
                kept = sorted(p.name for p in data.glob("*.json"))
                assert len(kept) == 6, kept
                moved = data / "excluded_recal"
                assert len(list(moved.glob("*.json"))) == 3 and len(list(moved.glob("*.csv"))) == 3, list(moved.iterdir())
                detail = call("GET", f"{api}/api/buildings/{building_id}", token)
                assert detail["active_incident"] is None, detail["active_incident"]
                for inc in (first_inc, second_inc):
                    assert call("GET", f"{api}/api/incidents/{inc}/state", token)["incident"]["status"] == "closed"
                log.flush()
                text = log_path.read_text("utf-8", errors="replace")
                assert "기준선을 다시 잡습니다" in text and "excluded_recal" in text
                print("PASS: 첫 빈 방 점검 → 다시 보정(감지", first_inc, "→", second_inc, ") → 빈 방 다시 녹화 → 끝까지 진행,",
                      "처음 빈 방 파일 3쌍은 excluded_recal로, 감지 모두 닫힘")
                print("단계:", " → ".join(f"{p}{'(' + s + ')' if s else ''}" for p, s, _ in seen))
            except BaseException:
                log.flush()
                print(log_path.read_text("utf-8", errors="replace")[-5000:])
                raise
            finally:
                for p in reversed(procs):
                    if p.poll() is None:
                        if os.name == "nt":
                            subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True)
                        else:
                            p.terminate()
                    p.wait(timeout=15)


if __name__ == "__main__":
    run()
