"""녹화하면서 화면으로 본 측정에서, 장면(시간)마다 화면 판단이 맞았는지 정리한다.

서버 DB(watchmate-be/data/app.db)에 남은 2초 판단 기록과, 녹화 폴더 장면 파일(.json)의 시작 시각을 맞춰 본다.
DB와 녹화 파일은 읽기만 한다. 결과는 화면에 표로 보여 주고, 같은 내용을 녹화 폴더에 judge_<날짜>.csv로 저장한다.

화면과 같은 방식으로 계산한다.
  - 노드별 p를 지수 평균(α=0.5)으로 부드럽게 한다. 프레임이 모자란 창(품질 0.7 미만)은 뺀다.
  - 구역 판단: 사람 측정됨 p ≥ 0.50, 있는지 애매함 0.20 ~ 0.50, 비어 있음 p < 0.20 (서버 기본 기준과 같음)
    서버 기준을 MEASURE_DETECT_P·MEASURE_POSSIBLE_P로 바꿨으면 그 값을 따르고, --present·--empty로 다시 채점할 수 있다.
  - 장면이 바뀐 직후는 판단이 따라오는 시간이라, 장면 앞 20초(--settle)는 빼고 센다. 반응 시간은 장면 시작부터 잰다.

실행(C:\\wm\\watchmate-be 폴더, .venv를 켠 PowerShell):
  python ..\\watchmate-fe\\scripts\\judge_by_scene.py --session ..\\data\\sessions\\2026-11-07e
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sqlite3
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve()
BE = Path(os.environ.get("WATCHMATE_BE") or HERE.parents[2] / "watchmate-be")
PRESENT = 0.50
EMPTY = 0.20
ALPHA = 0.5
MIN_QUALITY = 0.7
PERSON = {"standing", "sitting", "lying", "still", "moving", "walking", "behind_wall", "two_people"}
LABEL_KO = {"empty": "빈 방", "neighbor": "옆 구역", "standing": "서기", "sitting": "앉기", "lying": "눕기"}


def cls(p: float) -> str:
    return "측정됨" if p >= PRESENT else ("애매함" if p >= EMPTY else "비어 있음")


def env_float(name: str, default: float) -> float:
    """서버와 같은 기준을 쓰도록 환경 변수, 없으면 watchmate-be/.env에서 읽는다(MEASURE_DETECT_P 등)."""
    raw = os.environ.get(name)
    env_file = BE / ".env"
    if raw is None and env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            key, _, value = line.strip().partition("=")
            if key.strip() == name:
                raw = value.strip().strip('"').strip("'")
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


def to_epoch(value) -> float:
    dt = datetime.fromisoformat(str(value).replace("T", " "))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)  # 서버는 UTC로 저장한다
    return dt.timestamp()


def load_scenes(folder: Path) -> list[dict]:
    scenes: dict[tuple[str, float], dict] = {}
    for p in sorted(folder.glob("*.json")):
        try:
            meta = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if "started_at" not in meta or "node" not in meta or "scene" not in meta:
            continue
        key = (meta["scene"], round(float(meta["started_at"]), 1))
        sc = scenes.setdefault(key, {"scene": meta["scene"], "description": meta.get("description", ""),
                                     "start": float(meta["started_at"]), "seconds": float(meta.get("seconds") or 0),
                                     "labels": {}})
        sc["labels"][meta["node"]] = meta["label"]
        sc["seconds"] = max(sc["seconds"], float(meta.get("seconds") or 0))
    return sorted(scenes.values(), key=lambda s: s["start"])


def main() -> None:
    global PRESENT, EMPTY
    ap = argparse.ArgumentParser(description="장면(시간)마다 화면 판단이 맞았는지 정리")
    ap.add_argument("--session", required=True, help="녹화 폴더(예: ..\\data\\sessions\\2026-11-07e)")
    ap.add_argument("--db", default=str(BE / "data" / "app.db"), help="서버 DB 파일")
    ap.add_argument("--settle", type=float, default=20.0, help="장면 시작 뒤 세지 않는 시간(초)")
    # 저장된 p로 다른 기준을 넣어 다시 채점할 수 있다(예: --present 0.6 --empty 0.3). 기본은 서버 기준과 같다.
    ap.add_argument("--present", type=float, default=env_float("MEASURE_DETECT_P", PRESENT), help="'측정됨' 기준 p")
    ap.add_argument("--empty", type=float, default=env_float("MEASURE_POSSIBLE_P", EMPTY), help="'애매함' 기준 p")
    args = ap.parse_args()
    if not 0 < args.empty < args.present < 1:
        sys.exit("기준은 0 < --empty < --present < 1이어야 해요.")
    PRESENT, EMPTY = args.present, args.empty

    folder = Path(args.session)
    scenes = load_scenes(folder)
    if not scenes:
        sys.exit(f"장면 파일(.json)을 찾지 못했어요: {folder}")
    db_path = Path(args.db)
    if not db_path.exists():
        sys.exit(f"서버 DB를 찾지 못했어요: {db_path}")
    con = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
    zone_name = {zid: name for zid, name in con.execute("select id, name from zones")}
    node_rows = list(con.execute("select id, name, zone_id from nodes where role = 'rx'"))
    t0 = scenes[0]["start"] - 60
    t1 = scenes[-1]["start"] + scenes[-1]["seconds"] + 60
    lo = datetime.fromtimestamp(t0, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    hi = datetime.fromtimestamp(t1, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    # 노드별 판단 흐름(시각, 지수 평균 p). 같은 이름 노드가 여러 건물에 있으면 이 시간대에 기록이 있는 쪽을 쓴다
    series: dict[str, list[tuple[float, float]]] = {}
    zone_of: dict[str, str] = {}
    for nid, name, zid in node_rows:
        rows = list(con.execute(
            "select t, p_change, p_person, quality from inferences where node_id = ? and t between ? and ? order by t",
            (nid, lo, hi)))
        if not rows:
            continue
        ema, pts = None, []
        for t, pc, pp, q in rows:
            if q is not None and q < MIN_QUALITY:
                continue
            p = pp if pp is not None else pc
            if p is None:
                continue
            ema = p if ema is None else ALPHA * p + (1 - ALPHA) * ema
            pts.append((to_epoch(t), ema))
        if pts and (name not in series or len(pts) > len(series[name])):
            series[name] = pts
            zone_of[name] = zone_name.get(zid, "?")

    if not series:
        sys.exit("이 녹화 시간대에 서버 판단 기록이 없어요. 화면 5단계에서 감지를 켰는지 확인하세요.")

    out_rows = []
    say = lambda s="": print(s, flush=True)  # noqa: E731
    say(f"판단 범위: 측정됨 p ≥ {PRESENT:.2f} · 애매함 {EMPTY:.2f}~{PRESENT:.2f} · 비어 있음 < {EMPTY:.2f}"
        f" · 장면 앞 {args.settle:.0f}초 제외")
    tally: dict[str, list[int]] = {}
    for i, sc in enumerate(scenes, 1):
        start, end = sc["start"], sc["start"] + sc["seconds"]
        clock = datetime.fromtimestamp(start).strftime("%H:%M:%S")
        say(f"\n[{i}] {sc['scene']} · {clock} 시작 · {sc['seconds']:.0f}초 · {sc['description']}")
        for node, label in sc["labels"].items():
            zone = zone_of.get(node, "?")
            pts = series.get(node, [])
            window = [p for t, p in pts if start + args.settle <= t <= end]
            person = label in PERSON
            expect = "측정됨" if person else "비어 있음"
            kind = "자기 구역 사람" if person else ("빈 방" if label == "empty" else "옆 구역 사람")
            if not window:
                say(f"  {zone}({node}) {LABEL_KO.get(label, label)} · 기대 {expect} → 기록 없음(감지 꺼짐)")
                out_rows.append([sc["scene"], clock, zone, node, label, expect, "", "", "", "", "", "", "기록 없음"])
                continue
            n = len(window)
            share = {c: sum(1 for p in window if cls(p) == c) / n for c in ("측정됨", "애매함", "비어 있음")}
            med = statistics.median(window)
            top = max(share, key=share.get)
            verdict = "맞음" if top == expect else ("애매" if top == "애매함" else "틀림")
            react = ""
            if person:
                hit = next((t for t, p in pts if start <= t <= end and p >= PRESENT), None)
                react = "" if hit is None else f"{hit - start:.0f}"
            tally.setdefault(kind, [0, 0])
            tally[kind][0] += verdict == "맞음"
            tally[kind][1] += 1
            say(f"  {zone}({node}) {LABEL_KO.get(label, label)} · 기대 {expect} → "
                f"측정됨 {share['측정됨']:.0%} · 애매함 {share['애매함']:.0%} · 비어 있음 {share['비어 있음']:.0%}"
                f" · p 중앙 {med:.2f}" + (f" · 첫 측정됨 {react}초" if react else (" · 측정됨 없음" if person else ""))
                + f" → {verdict}")
            out_rows.append([sc["scene"], clock, zone, node, label, expect, f"{share['측정됨']:.3f}",
                             f"{share['애매함']:.3f}", f"{share['비어 있음']:.3f}", f"{med:.3f}", n, react, verdict])

    say("\n요약(장면 × 구역, 가장 많이 나온 판단이 기대와 같으면 맞음)")
    for kind in ("자기 구역 사람", "빈 방", "옆 구역 사람"):
        if kind in tally:
            ok, total = tally[kind]
            say(f"  {kind}: {ok}/{total} 맞음")
    day = folder.name
    suffix = "" if (PRESENT, EMPTY) == (0.50, 0.20) else f"_p{PRESENT:.2f}-{EMPTY:.2f}"  # 다른 기준은 따로 저장
    out = folder / f"judge_{day}{suffix}.csv"
    with out.open("w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["장면", "시작", "구역", "노드", "라벨", "기대", "측정됨비율", "애매함비율", "비어있음비율",
                    "p중앙", "판단수", "첫측정됨초", "결과"])
        w.writerows(out_rows)
    say(f"\n저장: {out}")


if __name__ == "__main__":
    main()
