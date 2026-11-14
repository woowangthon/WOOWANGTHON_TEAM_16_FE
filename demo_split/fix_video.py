"""녹화한 mp4를 '뒤로 넘길 수 있는' mp4로 바꾼다.

크롬의 탭 녹화는 영상을 작은 조각으로 이어 붙인 파일(조각 mp4)을 만든다. 이 파일에는 전체 길이와
위치 표가 없어서, 윈도우 미디어 플레이어 같은 재생기에서는 길이가 안 보이고 원하는 시각으로 못 넘긴다.
이 도구는 영상을 다시 압축하지 않고(화질 그대로) 조각을 하나로 모으고 길이·위치 표를 써 넣는다.

쓰는 법:
    python fix_video.py                 다운로드 폴더의 가장 최근 watchmate_demo_*.mp4
    python fix_video.py 파일.mp4 ...     고른 파일
결과는 같은 폴더에 '<이름>_seek.mp4'로 생긴다. 원본은 그대로 둔다.
"""
from __future__ import annotations

import struct
import sys
from pathlib import Path

CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"mvex", b"moof", b"traf", b"edts", b"dinf"}


def children(data: bytes) -> list[tuple[bytes, bytes]]:
    out, pos = [], 0
    while pos + 8 <= len(data):
        size, kind = struct.unpack(">I4s", data[pos:pos + 8])
        head = 8
        if size == 1:
            size, head = struct.unpack(">Q", data[pos + 8:pos + 16])[0], 16
        elif size == 0:
            size = len(data) - pos
        out.append((kind, data[pos + head:pos + size]))
        pos += size
    return out


def box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I4s", len(payload) + 8, kind) + payload


def find(kids: list, kind: bytes) -> bytes | None:
    return next((p for k, p in kids if k == kind), None)


def top_boxes(f, size: int):
    pos = 0
    while pos + 8 <= size:
        f.seek(pos)
        head = f.read(16)
        n, kind = struct.unpack(">I4s", head[:8])
        hdr = 8
        if n == 1:
            n, hdr = struct.unpack(">Q", head[8:16])[0], 16
        elif n == 0:
            n = size - pos
        if n < hdr:
            break
        yield kind, pos, hdr, n
        pos += n


def set_duration(payload: bytes, at32: int, at64: int, value: int) -> bytes:
    """mvhd·tkhd·mdhd의 길이 칸을 채운다(판 0은 4바이트, 판 1은 8바이트)."""
    if payload[0] == 0:
        return payload[:at32] + struct.pack(">I", min(value, 0xFFFFFFFF)) + payload[at32 + 4:]
    return payload[:at64] + struct.pack(">Q", value) + payload[at64 + 8:]


def runs(values: list) -> list[tuple[int, int]]:
    out: list[list] = []
    for v in values:
        if out and out[-1][1] == v:
            out[-1][0] += 1
        else:
            out.append([1, v])
    return [(c, v) for c, v in out]


def convert(src: Path, dst: Path) -> str:
    size = src.stat().st_size
    with src.open("rb") as f:
        tops = list(top_boxes(f, size))
        kinds = [k for k, *_ in tops]
        if b"moof" not in kinds:
            return "이미 넘길 수 있는 파일이에요(조각 mp4가 아님). 그대로 쓰면 돼요."
        ftyp = b"".join(_read(f, pos, n) for k, pos, hdr, n in tops if k == b"ftyp")
        moov_pos = next(((pos, hdr, n) for k, pos, hdr, n in tops if k == b"moov"), None)
        if not moov_pos:
            return "영상 정보(moov)가 없어서 고칠 수 없어요. 녹화가 중간에 끊긴 파일일 수 있어요."
        moov = children(_read(f, moov_pos[0] + moov_pos[1], moov_pos[2] - moov_pos[1]))
        traks = [p for k, p in moov if k == b"trak"]
        if len(traks) != 1:
            return f"트랙이 {len(traks)}개예요. 이 도구는 영상 트랙 하나짜리(소리 없는 녹화)만 고쳐요."
        trak = children(traks[0])
        mdia = children(find(trak, b"mdia"))
        mdhd = find(mdia, b"mdhd")
        media_ts = struct.unpack(">I", mdhd[12:16] if mdhd[0] == 0 else mdhd[20:24])[0]
        mvhd = find(moov, b"mvhd")
        movie_ts = struct.unpack(">I", mvhd[12:16] if mvhd[0] == 0 else mvhd[20:24])[0]
        minf = children(find(mdia, b"minf"))
        stbl = children(find(minf, b"stbl"))
        trex = find(children(find(moov, b"mvex") or b""), b"trex") or bytes(24)
        d_dur, d_size, d_flags = struct.unpack(">III", trex[12:24])

        # 조각마다 샘플(프레임)의 크기·길이·위치를 모은다
        sizes, durs, syncs, ctos, chunks = [], [], [], [], []  # chunks: (원본 위치, 바이트 수, 샘플 수)
        for kind, pos, hdr, n in tops:
            if kind != b"moof":
                continue
            for k, traf in children(_read(f, pos + hdr, n - hdr)):
                if k != b"traf":
                    continue
                parts = children(traf)
                tfhd = find(parts, b"tfhd")
                tf = struct.unpack(">I", tfhd[0:4])[0] & 0xFFFFFF
                at, base = 8, pos
                if tf & 0x1:
                    base = struct.unpack(">Q", tfhd[at:at + 8])[0]
                    at += 8
                if tf & 0x2:
                    at += 4
                dur0, size0, flags0 = d_dur, d_size, d_flags
                if tf & 0x8:
                    dur0 = struct.unpack(">I", tfhd[at:at + 4])[0]
                    at += 4
                if tf & 0x10:
                    size0 = struct.unpack(">I", tfhd[at:at + 4])[0]
                    at += 4
                if tf & 0x20:
                    flags0 = struct.unpack(">I", tfhd[at:at + 4])[0]
                next_off = None
                for k2, trun in parts:
                    if k2 != b"trun":
                        continue
                    ver = trun[0]
                    rf = struct.unpack(">I", trun[0:4])[0] & 0xFFFFFF
                    count = struct.unpack(">I", trun[4:8])[0]
                    at = 8
                    off = next_off if next_off is not None else base
                    if rf & 0x1:
                        off = base + struct.unpack(">i", trun[at:at + 4])[0]
                        at += 4
                    first_flags = None
                    if rf & 0x4:
                        first_flags = struct.unpack(">I", trun[at:at + 4])[0]
                        at += 4
                    total = 0
                    for i in range(count):
                        dur, sz, fl, cto = dur0, size0, flags0, 0
                        if rf & 0x100:
                            dur = struct.unpack(">I", trun[at:at + 4])[0]
                            at += 4
                        if rf & 0x200:
                            sz = struct.unpack(">I", trun[at:at + 4])[0]
                            at += 4
                        if rf & 0x400:
                            fl = struct.unpack(">I", trun[at:at + 4])[0]
                            at += 4
                        elif i == 0 and first_flags is not None:
                            fl = first_flags
                        if rf & 0x800:
                            cto = struct.unpack(">i" if ver else ">I", trun[at:at + 4])[0]
                            at += 4
                        sizes.append(sz)
                        durs.append(dur)
                        syncs.append(not fl & 0x10000)
                        ctos.append(cto)
                        total += sz
                    if count:
                        chunks.append((off, total, count))
                    next_off = off + total
        if not sizes:
            return "영상 조각에 프레임이 없어요. 고칠 수 없어요."
        if any(off + n > size for off, n, _ in chunks):
            return "파일 끝이 잘려 있어요(녹화가 끝까지 저장되지 않음). 고칠 수 없어요."

        media_dur = sum(durs)
        movie_dur = round(media_dur * movie_ts / media_ts)
        full = lambda payload: bytes(4) + payload
        stts = box(b"stts", full(struct.pack(">I", len(runs(durs))) + b"".join(struct.pack(">II", c, v) for c, v in runs(durs))))
        stsz = box(b"stsz", full(struct.pack(">II", 0, len(sizes)) + struct.pack(f">{len(sizes)}I", *sizes)))
        per = runs([c for _, _, c in chunks])
        stsc_rows, first = [], 1
        for count, samples in per:
            stsc_rows.append(struct.pack(">III", first, samples, 1))
            first += count
        stsc = box(b"stsc", full(struct.pack(">I", len(stsc_rows)) + b"".join(stsc_rows)))
        extra = b""
        if not all(syncs):
            keys = [i + 1 for i, s in enumerate(syncs) if s]
            extra += box(b"stss", full(struct.pack(">I", len(keys)) + struct.pack(f">{len(keys)}I", *keys)))
        if any(ctos):
            rows = runs(ctos)
            neg = any(v < 0 for _, v in rows)
            extra += box(b"ctts", bytes([1 if neg else 0, 0, 0, 0]) + struct.pack(">I", len(rows))
                         + b"".join(struct.pack(">Ii" if neg else ">II", c, v) for c, v in rows))

        def build(offsets: list[int]) -> bytes:
            co64 = box(b"co64", full(struct.pack(">I", len(offsets)) + struct.pack(f">{len(offsets)}Q", *offsets)))
            new_stbl = box(b"stbl", box(b"stsd", find(stbl, b"stsd")) + stts + extra + stsc + stsz + co64)
            new_minf = box(b"minf", b"".join(box(k, p) for k, p in minf if k != b"stbl") + new_stbl)
            new_mdia = box(b"mdia", b"".join(
                box(k, set_duration(p, 16, 24, media_dur)) if k == b"mdhd" else new_minf if k == b"minf" else box(k, p)
                for k, p in mdia))
            new_trak = box(b"trak", b"".join(
                box(k, set_duration(p, 20, 28, movie_dur)) if k == b"tkhd" else new_mdia if k == b"mdia" else box(k, p)
                for k, p in trak if k != b"edts"))
            return box(b"moov", b"".join(
                box(k, set_duration(p, 16, 24, movie_dur)) if k == b"mvhd" else new_trak if k == b"trak" else box(k, p)
                for k, p in moov if k != b"mvex"))

        data_len = sum(n for _, n, _ in chunks)
        mdat_head = struct.pack(">I4sQ", 1, b"mdat", data_len + 16)
        start = len(ftyp) + len(build([0] * len(chunks))) + len(mdat_head)  # 영상 정보를 앞에 둔다(바로 넘길 수 있게)
        offsets, at = [], start
        for _, n, _ in chunks:
            offsets.append(at)
            at += n
        tmp = dst.with_suffix(".tmp")
        with tmp.open("wb") as out:
            out.write(ftyp + build(offsets) + mdat_head)
            for off, n, _ in chunks:
                f.seek(off)
                left = n
                while left:
                    buf = f.read(min(left, 8 << 20))
                    if not buf:
                        raise OSError("원본을 끝까지 읽지 못했어요")
                    out.write(buf)
                    left -= len(buf)
        tmp.replace(dst)
    secs = media_dur / media_ts
    return f"고쳤어요 → {dst.name} · 길이 {int(secs // 60)}분 {secs % 60:04.1f}초 · 프레임 {len(sizes)}장(평균 초당 {len(sizes) / secs:.1f}장)"


def _read(f, pos: int, n: int) -> bytes:
    f.seek(pos)
    return f.read(n)


def main() -> None:
    files = [Path(a) for a in sys.argv[1:]]
    if not files:
        found = sorted((p for p in (Path.home() / "Downloads").glob("watchmate_demo_*.mp4") if not p.stem.endswith("_seek")),
                       key=lambda p: p.stat().st_mtime)
        if not found:
            print("다운로드 폴더에 watchmate_demo_*.mp4가 없어요. 파일을 이 창에 끌어다 놓거나 경로를 적어 주세요.")
            return
        files = [found[-1]]
    for src in files:
        print(f"{src.name} ({src.stat().st_size / 1e6:.0f}MB) 고치는 중...")
        try:
            print("  " + convert(src, src.with_name(src.stem + "_seek.mp4")))
        except (OSError, struct.error, TypeError) as exc:
            print(f"  고치지 못했어요: {exc}")


if __name__ == "__main__":
    main()
