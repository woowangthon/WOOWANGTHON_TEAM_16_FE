"""보정 뒤 보드가 다시 켜졌을 때 녹화 도우미가 안내하고 멈추는지 보는 로컬 종단 시험.

recording_browser.py와 같은 방식(가짜 USB 입력, 실제 FastAPI·Vite·Chromium)으로 돌린다.
녹화 중에 가짜 보드의 재시작 횟수를 1로 올리고 다음을 확인한다.
  - 녹화 도우미가 기다리지 않고 종료 코드 2로 끝난다.
  - 진행 중이던 장면 파일(.json)이 남지 않는다.
  - 감지가 닫힌다.
  - 창에 어느 보드가 다시 켜졌는지와 다시 하는 방법을 적는다.
watchmate-be 개발 환경(playwright 설치)으로 실행한다. CHROME_PATH로 로컬 Chromium을 줄 수 있다.
WATCHMATE_SHOT에 경로를 주면 '측정 멈춤' 화면을 그 파일로 저장한다.
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
    with tempfile.TemporaryDirectory(prefix="watchmate-restart-") as tmp:
        work = Path(tmp)
        flag = work / "restart.flag"
        nodes = ["RX-301", "RX-302", "RX-COR"]
        plan = work / "plan.csv"
        with plan.open("w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["scene", "description", "people", "seconds", *nodes])
            w.writerow(["empty", "빈 방", 0, 30, "empty", "empty", "empty"])
            w.writerow(["walk", "복도 걷기", 1, 4, "neighbor", "neighbor", "walking"])
        env = dict(os.environ, PYTHONPATH=sysconfig.get_path("purelib"), DATABASE_URL="sqlite:///" + (work / "test.db").as_posix(),
                   WATCHMATE_API=api_url, WATCHMATE_REC_PORT=str(rec_port), PYTHONUTF8="1", PYTHONUNBUFFERED="1",
                   WATCHMATE_SIM_RESTART_FLAG=str(flag))
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
                    page = browser.new_page(viewport={"width": 1280, "height": 900})
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
                    page.goto(ui_url)
                    page.evaluate("(s) => localStorage.setItem('wm.session', JSON.stringify(s))",
                                  {"token": auth["token"], "username": "demo", "expiresAt": auth["expires_at"]})
                    page.goto(ui_url)
                    recorder = start([sys._base_executable, str(FE / "tests" / "recording_browser.py"), "simulate",
                                      "--plan", str(plan), "--out", str(work / "data"), "--day", "synthetic",
                                      "--countdown", "0", "--calibration-seconds", "22",
                                      *(opt for n in nodes for opt in ("--node", n + "=sim"))], BE)

                    deadline = time.monotonic() + 90
                    while time.monotonic() < deadline and read_scene(rec_url).get("phase") != "recording":
                        if recorder.poll() is not None:
                            raise RuntimeError("Recorder exited before recording")
                        page.wait_for_timeout(200)
                    assert read_scene(rec_url).get("phase") == "recording", read_scene(rec_url)
                    page.wait_for_timeout(3000)  # 장면을 몇 초 찍은 뒤 보드를 다시 켠다
                    flag.write_text("restart", encoding="utf-8")

                    shot = os.environ.get("WATCHMATE_SHOT")
                    saw_stopped = False
                    deadline = time.monotonic() + 30
                    while recorder.poll() is None and time.monotonic() < deadline:
                        if read_scene(rec_url).get("phase") == "stopped" and not saw_stopped:
                            saw_stopped = True
                            page.wait_for_timeout(1500)  # 화면이 1초마다 받아 그린다
                            if shot:
                                page.screenshot(path=shot)
                        page.wait_for_timeout(200)
                    assert recorder.poll() == 2, f"exit code {recorder.poll()}"
                    assert saw_stopped, "'측정 멈춤' 단계를 보지 못했어요"
                    log.flush()
                    text = (work / "run.log").read_text("utf-8", errors="replace")
                    assert "보드가 보정 뒤에 다시 켜졌어요" in text and "--day만 새 값" in text, text[-2000:]
                    assert not list((work / "data").glob("*.json")), list((work / "data").glob("*.json"))
                    headers = {"Authorization": "Bearer " + auth["token"]}
                    sites = page.request.get(api_url + "/api/buildings", headers=headers).json()
                    assert len(sites) == 1 and sites[0]["active_incident_id"] is None, sites
                    browser.close()
                    print("PASS: restart after calibration stops the recorder with guidance, removes the open take,"
                          " closes detection")
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
    run()
