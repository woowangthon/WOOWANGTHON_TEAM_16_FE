"""보정 뒤 첫 빈 방 장면이 흔들리면 녹화 도우미가 다시 보정하고 빈 방부터 다시 찍는지 보는 로컬 종단 시험.

recording_browser.py와 같은 방식(가짜 USB 입력, 실제 FastAPI·Vite·Chromium)으로 돌린다.
가짜 보드 신호는 늘 같아서 흔들림이 생기지 않으므로, WATCHMATE_FORCE_RECAL=1로 첫 점검만 '흔들림'으로 만든다.
확인하는 것
  - 첫 빈 방 장면 뒤 다시 보정하고 새 감지로 같은 빈 방 장면을 다시 녹화한다.
  - 끝까지 진행해 종료 코드 0으로 끝나고, 녹화 폴더에는 장면 파일 6개(.json)만 남는다.
  - 처음 찍은 빈 방 장면 파일 3쌍(.csv·.json)은 excluded_recal 폴더로 옮겨진다(지우지 않음).
  - 감지는 모두 닫힌다.
watchmate-be 개발 환경(playwright 설치)으로 실행한다. CHROME_PATH로 로컬 Chromium을 줄 수 있다.
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
from urllib.request import urlopen

FE = Path(__file__).resolve().parents[1]
BE = FE.parent / "watchmate-be"
SIM = FE / "tests" / "recording_browser.py"  # 가짜 USB 입력으로 record_live를 실행하는 진입점


def read_scene(rec_url):
    try:
        with urlopen(rec_url + "/rec/scene", timeout=2) as response:
            return json.load(response)
    except OSError:
        return {}


def available_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def run():
    from playwright.sync_api import sync_playwright

    api_port, ui_port, rec_port = (available_port() for _ in range(3))
    api_url, ui_url, rec_url = [f"http://127.0.0.1:{p}" for p in (api_port, ui_port, rec_port)]
    with tempfile.TemporaryDirectory(prefix="watchmate-recal-") as tmp:
        work = Path(tmp)
        nodes = ["RX-301", "RX-302", "RX-COR"]
        plan = work / "plan.csv"
        with plan.open("w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["scene", "description", "people", "seconds", *nodes])
            w.writerow(["start_empty", "빈 방", 0, 12, "empty", "empty", "empty"])
            w.writerow(["walk", "복도 걷기", 1, 4, "neighbor", "neighbor", "walking"])
        env = dict(os.environ, PYTHONPATH=sysconfig.get_path("purelib"), DATABASE_URL="sqlite:///" + (work / "test.db").as_posix(),
                   WATCHMATE_API=api_url, WATCHMATE_REC_PORT=str(rec_port), PYTHONUTF8="1", PYTHONUNBUFFERED="1",
                   WATCHMATE_FORCE_RECAL="1")
        processes = []
        with (work / "run.log").open("w", encoding="utf-8") as log:
            def start(args, cwd):
                proc = subprocess.Popen(args, cwd=cwd, env=env, stdout=log, stderr=log)
                processes.append(proc)
                return proc

            try:
                start([sys._base_executable, "-m", "uvicorn", "app.main:app", "--port", str(api_port), "--no-access-log"], BE)
                start(["node", str(FE / "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", str(ui_port), "--strictPort"], FE)
                with sync_playwright() as pw:
                    browser = pw.chromium.launch(executable_path=os.environ.get("CHROME_PATH"))
                    page = browser.new_page()
                    for url in (api_url + "/api/health", ui_url):
                        for _ in range(100):
                            try:
                                with urlopen(url, timeout=1):
                                    break
                            except OSError:
                                time.sleep(0.25)
                        else:
                            raise RuntimeError("Server did not start: " + url)
                    auth = page.request.post(api_url + "/api/auth/login",
                                             data={"username": "demo", "password": "demo1234"}).json()
                    headers = {"Authorization": "Bearer " + auth["token"]}
                    page.goto(ui_url)
                    page.evaluate("(s) => localStorage.setItem('wm.session', JSON.stringify(s))",
                                  {"token": auth["token"], "username": "demo", "expiresAt": auth["expires_at"]})
                    page.goto(ui_url + "/records")
                    recorder = start([sys._base_executable, str(SIM), "simulate", "--plan", str(plan), "--out", str(work / "data"),
                                      "--day", "synthetic", "--countdown", "0", "--calibration-seconds", "22",
                                      *(opt for n in nodes for opt in ("--node", n + "=sim"))], BE)

                    def wait_phase(phase, timeout=60, scene=None):
                        deadline = time.monotonic() + timeout
                        while time.monotonic() < deadline:
                            if recorder.poll() is not None:
                                raise RuntimeError("Recorder exited early")
                            state = read_scene(rec_url)
                            if state.get("phase") == phase and (scene is None or state.get("scene") == scene):
                                return state
                            page.wait_for_timeout(200)
                        raise TimeoutError(f"Expected {phase}, got {read_scene(rec_url)}")

                    wait_phase("setup")
                    page.goto(ui_url)
                    first = wait_phase("recording", 90, "start_empty")
                    wait_phase("calibrating", 60)  # 첫 빈 방 점검에 걸려 다시 보정
                    again = wait_phase("recording", 120, "start_empty")
                    assert again["incident_id"] and again["incident_id"] != first["incident_id"], (first, again)
                    assert again["started_at"] > first["started_at"]
                    deadline = time.monotonic() + 90
                    while recorder.poll() is None and time.monotonic() < deadline:
                        page.wait_for_timeout(250)
                    assert recorder.poll() == 0, read_scene(rec_url)
                    data = work / "data"
                    kept = sorted(p.name for p in data.glob("*.json"))
                    assert len(kept) == 6, kept
                    moved = data / "excluded_recal"
                    assert len(list(moved.glob("*.json"))) == 3 and len(list(moved.glob("*.csv"))) == 3, list(moved.iterdir())
                    sites = page.request.get(api_url + "/api/buildings", headers=headers).json()
                    assert len(sites) == 1 and sites[0]["active_incident_id"] is None
                    for incident_id in (first["incident_id"], again["incident_id"]):
                        st = page.request.get(api_url + f"/api/incidents/{incident_id}/state", headers=headers).json()
                        assert st["incident"]["status"] == "closed", st["incident"]
                    log.flush()
                    text = (work / "run.log").read_text("utf-8", errors="replace")
                    assert "기준선을 다시 잡습니다" in text and "excluded_recal" in text
                    browser.close()
                    print("PASS: 첫 빈 방 점검 → 다시 보정(새 감지) → 빈 방 다시 녹화 → 끝까지 진행, "
                          "처음 빈 방 파일은 excluded_recal로 옮김, 감지 모두 닫힘")
            except BaseException:
                log.flush()
                print((work / "run.log").read_text("utf-8", errors="replace")[-4000:])
                raise
            finally:
                for proc in reversed(processes):
                    if proc.poll() is None:
                        if os.name == "nt":
                            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
                        else:
                            proc.terminate()
                    proc.wait(timeout=15)


if __name__ == "__main__":
    run()
