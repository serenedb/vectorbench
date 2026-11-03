"""Empty the page cache of an engine's data before a group, as root.

`drop_caches` frees every clean page no process maps. Pages a process maps stay, so for an engine
that memory-maps its vectors the files it names are paged out of its own mappings with
process_madvise(MADV_PAGEOUT). Only the files a participant names go: a graph or codes an engine
maps on purpose to keep in RAM stay, as SereneDB's graph and codes stay in its heap.

    sudo python -I evict.py <cgroup dir> [path substring ...]"""

from __future__ import annotations

import ctypes
import os
import sys
from pathlib import Path

SYS_PROCESS_MADVISE = 440
SYS_PIDFD_OPEN = 434
MADV_PAGEOUT = 21
# process_madvise advises at most MAX_RW_COUNT (about 2 GiB) per call and says so only in its
# return value; a whole-file mapping of a 120 GB column file needs many calls.
CHUNK = 1 << 30


class IoVec(ctypes.Structure):
    _fields_ = [("base", ctypes.c_void_p), ("len", ctypes.c_size_t)]


def mapped_ranges(pid: int, needles: list[str]) -> list[tuple[int, int]]:
    out = []
    for line in Path(f"/proc/{pid}/maps").read_text().splitlines():
        parts = line.split(None, 5)
        if len(parts) < 6 or not any(n in parts[5] for n in needles):
            continue
        lo, hi = (int(x, 16) for x in parts[0].split("-"))
        for base in range(lo, hi, CHUNK):
            out.append((base, min(CHUNK, hi - base)))
    return out


def resident_file_kb(pid: int, needles: list[str]) -> int:
    kb = 0
    hit = False
    for line in Path(f"/proc/{pid}/smaps").read_text().splitlines():
        head = line.split(None, 5)
        if "-" in head[0] and len(head) >= 5 and not head[0].endswith(":"):
            hit = len(head) == 6 and any(n in head[5] for n in needles)
        elif hit and line.startswith("Rss:"):
            kb += int(line.split()[1])
    return kb


def page_out(pid: int, needles: list[str]) -> tuple[int, int]:
    ranges = mapped_ranges(pid, needles)
    if not ranges:
        return 0, 0
    libc = ctypes.CDLL(None, use_errno=True)
    fd = libc.syscall(SYS_PIDFD_OPEN, pid, 0)
    if fd < 0:
        raise OSError(ctypes.get_errno(), f"pidfd_open {pid}")
    before = resident_file_kb(pid, needles)
    try:
        for base, n in ranges:
            iov = (IoVec * 1)(IoVec(base, n))
            if libc.syscall(SYS_PROCESS_MADVISE, fd, iov, 1, MADV_PAGEOUT, 0) < 0:
                raise OSError(ctypes.get_errno(), f"process_madvise {pid}")
    finally:
        os.close(fd)
    return before, resident_file_kb(pid, needles)


def main(argv: list[str]) -> int:
    cgroup, needles = Path(argv[0]), argv[1:]
    os.sync()
    Path("/proc/sys/vm/drop_caches").write_text("3\n")
    if needles:
        for pid in (int(x) for x in (cgroup / "cgroup.procs").read_text().split()):
            before, after = page_out(pid, needles)
            if before:
                print(f"pid {pid}: {before >> 10} MiB -> {after >> 10} MiB resident in {needles}")
    st = dict(line.split() for line in (cgroup / "memory.stat").read_text().splitlines())
    print(f"cgroup file pages {int(st['file']) >> 20} MiB, mapped {int(st['file_mapped']) >> 20} MiB, anon {int(st['anon']) >> 30} GiB")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
