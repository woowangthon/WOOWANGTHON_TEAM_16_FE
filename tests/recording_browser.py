"""Local end-to-end regression with synthetic USB input, real FastAPI, Vite and Chromium.

Run using watchmate-be's development environment with playwright installed.
Set CHROME_PATH to a local Chromium executable or install Playwright Chromium.
All test data stays in a temporary directory.
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
sys.path.insert(0, str(FE / "scripts"))
import record_live


def simulate_usb():
    col = record_live.load_collector()

    class Port:
        def readline(self):
            # Valid CSI protocol with deterministic amplitudes; no physical device.
            time.sleep(0.02)
            return b'CSI_DATA,0,0,-45,"[2,10,7,3,3,4,12,4,3,7,8,3,4,7,9,4]"\n'

        def close(self):
            pass

        def restarts_since_open(self):
            # 재시작 시험(recording_restart_browser.py): 이 파일이 생기면 보드가 한 번 다시 켜진 것으로 센다.
            flag = os.environ.get("WATCHMATE_SIM_RESTART_FLAG")
            return 1 if flag and Path(flag).exists() else 0

    col._open_serial = lambda port, baud: Port()
    record_live.load_collector = lambda: col
    sys.argv = [sys.argv[0], *sys.argv[2:]]
    record_live.main()


def read_scene(rec_url):
    try:
        with urlopen(rec_url + "/rec/scene", timeout=2) as response:
            return json.load(response)
    except OSError:
        return {}


def run():
    from playwright.sync_api import sync_playwright

    def available_port():
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]
    api_port, ui_port, rec_port = (available_port() for _ in range(3))
    api_url, ui_url, rec_url = [f"http://127.0.0.1:{p}" for p in (api_port, ui_port, rec_port)]
    with tempfile.TemporaryDirectory(prefix="watchmate-sync-") as tmp:
        work = Path(tmp)
        nodes = ["RX-301", "RX-302", "RX-COR"]
        plan = work / "plan.csv"
        with plan.open("w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["scene", "description", "people", "seconds", *nodes])
            w.writerow(["empty", "빈 방", 0, 12, "empty", "empty", "empty"])
            w.writerow(["walk", "복도 걷기", 1, 4, "neighbor", "neighbor", "walking"])
        env = dict(os.environ, PYTHONPATH=sysconfig.get_path("purelib"), DATABASE_URL="sqlite:///" + (work / "test.db").as_posix(),
                   WATCHMATE_API=api_url, WATCHMATE_REC_PORT=str(rec_port), PYTHONUTF8="1", PYTHONUNBUFFERED="1")
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
                    chrome = os.environ.get("CHROME_PATH")
                    browser = pw.chromium.launch(executable_path=chrome)
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
                    # The only interactive prerequisite is an authenticated user.
                    auth = page.request.post(api_url + "/api/auth/login",
                                             data={"username": "demo", "password": "demo1234"}).json()
                    page.goto(ui_url)
                    page.evaluate("(s) => localStorage.setItem('wm.session', JSON.stringify(s))",
                                  {"token": auth["token"], "username": "demo", "expiresAt": auth["expires_at"]})
                    page.goto(ui_url + "/records")
                    recorder = start([sys._base_executable, __file__, "simulate", "--plan", str(plan), "--out", str(work / "data"),
                                      "--day", "synthetic", "--countdown", "0", "--calibration-seconds", "22",
                                      *(opt for n in nodes for opt in ("--node", n + "=sim"))], BE)

                    def wait_phase(phase, timeout=60):
                        deadline = time.monotonic() + timeout
                        while time.monotonic() < deadline:
                            if recorder.poll() is not None:
                                raise RuntimeError("Recorder exited early")
                            state = read_scene(rec_url)
                            if state.get("phase") == phase:
                                return state
                            page.wait_for_timeout(200)
                        raise TimeoutError(f"Expected {phase}, got {read_scene(rec_url)}")

                    wait_phase("setup")
                    page.wait_for_timeout(1800)
                    assert read_scene(rec_url)["phase"] == "setup"
                    page.goto(ui_url)
                    original = wait_phase("recording")
                    assert original["scene"] == "empty"
                    headers = {"Authorization": "Bearer " + auth["token"]}
                    incident_state = page.request.get(api_url + f"/api/incidents/{original['incident_id']}/state",
                                                      headers=headers).json()
                    assert incident_state["incident"]["source"] == "measurement"
                    assert incident_state["thresholds"] == {"detected": 0.5, "possible": 0.2}
                    # Leaving the measurement page during a take no longer stops it: the scene records to the end,
                    # then the helper waits on "between" until the page is back and has saved the scene records.
                    page.goto(ui_url + "/records")
                    done = wait_phase("between", 30)
                    assert done["scene"] == original["scene"] and done["started_at"] == original["started_at"]
                    assert len(list((work / "data").glob("*.json"))) == 3
                    page.goto(ui_url)
                    deadline = time.monotonic() + 60
                    while recorder.poll() is None and time.monotonic() < deadline:
                        page.wait_for_timeout(250)
                    assert recorder.poll() == 0, read_scene(rec_url)
                    records = page.evaluate("JSON.parse(localStorage.getItem('wm.records'))")
                    assert len(records) == 6 and all(r["how"] == "자동" for r in records), records
                    assert any(r["truth"] == "present" and "walk" in r["note"] for r in records)
                    assert len(list((work / "data").glob("*.json"))) == 6
                    sites = page.request.get(api_url + "/api/buildings",
                                             headers={"Authorization": "Bearer " + auth["token"]}).json()
                    assert len(sites) == 1 and sites[0]["active_incident_id"] is None
                    browser.close()
                    print("PASS: visible-page gate, no-click setup/calibration/detection, take continues off-page,"
                          " six saved results, automatic stop")
            except BaseException:
                log.flush()
                print((work / "run.log").read_text("utf-8", errors="replace")[-3500:])
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
    if sys.argv[1:2] == ["simulate"]:
        simulate_usb()
    else:
        run()
