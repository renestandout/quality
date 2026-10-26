#!/usr/bin/env python3
"""Übernimmt erlaubte Dateien aus scratch/ nach artifacts/.

Setzt die 11 Schritte aus «Write isolation» im Skill security-audit um.
Jede Datei wird einzeln übernommen. Kein Pfad wird zweimal geöffnet.
Nur Python-Standardbibliothek, lauffähig ab Python 3.9.
"""

from __future__ import annotations

import errno
import json
import os
import stat
from dataclasses import dataclass
from typing import Callable, Optional

CHUNK = 64 * 1024
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
SRC_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
DEST_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW


@dataclass(frozen=True)
class Entry:
    path: str
    max_bytes: int


@dataclass(frozen=True)
class Manifest:
    files: tuple
    max_total_bytes: int


@dataclass
class Result:
    path: str
    status: str
    reason: Optional[str]
    bytes: int


class PromoteError(Exception):
    """Grund der Ablehnung. Der Text beginnt mit einem Code und einem Doppelpunkt."""


def platform_supported() -> bool:
    """Schritt 9: Ohne dir_fd- und no-follow-Unterstützung wird nichts übernommen."""
    return os.open in os.supports_dir_fd and os.mkdir in os.supports_dir_fd and hasattr(os, "O_NOFOLLOW")


def _positive_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def load_manifest(path: str) -> Manifest:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or not _positive_int(data.get("max_total_bytes")):
        raise ValueError("Manifest: max_total_bytes fehlt oder ist nicht positiv")
    files = data.get("files")
    if not isinstance(files, list):
        raise ValueError("Manifest: files fehlt")
    entries = []
    seen = set()
    for item in files:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise ValueError("Manifest: Eintrag ohne path")
        if not _positive_int(item.get("max_bytes")):
            raise ValueError(f"Manifest: max_bytes für {item['path']!r} fehlt oder ist nicht positiv")
        try:
            split_rel_path(item["path"])
        except PromoteError as e:
            raise ValueError(f"Manifest: {e}") from None
        if item["path"] in seen:
            raise ValueError(f"Manifest: {item['path']!r} doppelt")
        seen.add(item["path"])
        entries.append(Entry(item["path"], item["max_bytes"]))
    return Manifest(tuple(entries), data["max_total_bytes"])


def split_rel_path(rel: str) -> list:
    """Schritt 1: relativer Pfad ohne leere, '.'- oder '..'-Teile."""
    if not rel or "\0" in rel or rel.startswith("/"):
        raise PromoteError(f"invalid-path: {rel!r}")
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise PromoteError(f"invalid-path: {rel!r}")
    return parts


def _open_dir(parent_fd: int, name: str, code: str) -> int:
    try:
        return os.open(name, DIR_FLAGS, dir_fd=parent_fd)
    except OSError as e:
        if e.errno == errno.ENOENT:
            raise PromoteError(f"missing: {name}") from None
        if e.errno in (errno.ELOOP, errno.ENOTDIR):
            raise PromoteError(f"{code}: {name}") from None
        raise PromoteError(f"{code}: {name}: {e.strerror}") from None


def _walk_source(scratch_fd: int, parts: list) -> int:
    """Schritt 2: Elternordner einzeln no-follow vom Scratch-Deskriptor aus öffnen."""
    fd = os.dup(scratch_fd)
    try:
        for name in parts:
            nxt = _open_dir(fd, name, "symlink")
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def _walk_dest(artifacts_fd: int, parts: list) -> int:
    """Schritt 7: Zielordner no-follow ablaufen, fehlende exklusiv anlegen."""
    fd = os.dup(artifacts_fd)
    try:
        for name in parts:
            try:
                os.mkdir(name, 0o700, dir_fd=fd)
            except FileExistsError:
                pass
            try:
                nxt = os.open(name, DIR_FLAGS, dir_fd=fd)
            except OSError as e:
                raise PromoteError(f"dest-not-dir: {name}: {e.strerror}") from None
            if not stat.S_ISDIR(os.fstat(nxt).st_mode):
                os.close(nxt)
                raise PromoteError(f"dest-not-dir: {name}")
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def _identity(st: os.stat_result) -> tuple:
    return (st.st_dev, st.st_ino, st.st_mode, st.st_nlink, st.st_size, st.st_mtime_ns)


def _check_source(st: os.stat_result, entry: Entry, remaining_total: int) -> None:
    """Schritt 4: regulär, genau ein Link, innerhalb beider Limits."""
    if not stat.S_ISREG(st.st_mode):
        raise PromoteError(f"not-regular: {entry.path}")
    if st.st_nlink != 1:
        raise PromoteError(f"hardlink: {entry.path} hat {st.st_nlink} Links")
    if st.st_size > entry.max_bytes:
        raise PromoteError(f"too-large: {entry.path} hat {st.st_size} Bytes, erlaubt {entry.max_bytes}")
    if st.st_size > remaining_total:
        raise PromoteError(f"total-exceeded: {entry.path} hat {st.st_size} Bytes, übrig {remaining_total}")


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        n = os.write(fd, view)
        view = view[n:]


def promote_file(
    scratch_fd: int,
    artifacts_fd: int,
    entry: Entry,
    remaining_total: int,
    *,
    _after_copy: Optional[Callable[[int], None]] = None,
) -> int:
    """Übernimmt eine Datei. Gibt die kopierten Bytes zurück oder wirft PromoteError.

    Ein halb geschriebenes Ziel entfernt diese Funktion selbst (Schritt 11).
    """
    parts = split_rel_path(entry.path)
    src_dir = _walk_source(scratch_fd, parts[:-1])
    try:
        # Schritt 3: Blatt no-follow und nonblocking öffnen.
        try:
            src = os.open(parts[-1], SRC_FLAGS, dir_fd=src_dir)
        except OSError as e:
            if e.errno == errno.ENOENT:
                raise PromoteError(f"missing: {entry.path}") from None
            if e.errno == errno.ELOOP:
                raise PromoteError(f"symlink: {entry.path}") from None
            raise PromoteError(f"not-regular: {entry.path}: {e.strerror}") from None
    finally:
        os.close(src_dir)

    try:
        before = os.fstat(src)
        _check_source(before, entry, remaining_total)
        limit = min(entry.max_bytes, remaining_total, before.st_size)

        # Schritt 5 und 6: mit Limit lesen, genau die geprüfte Grösse.
        chunks = []
        total = 0
        while total < before.st_size:
            chunk = os.read(src, min(CHUNK, before.st_size - total))
            if not chunk:
                raise PromoteError(f"changed: {entry.path} ist beim Lesen geschrumpft")
            total += len(chunk)
            if total > limit:
                raise PromoteError(f"too-large: {entry.path} überschreitet beim Lesen das Limit")
            chunks.append(chunk)
        if os.read(src, 1):
            raise PromoteError(f"changed: {entry.path} ist beim Lesen gewachsen")
        if _after_copy is not None:
            _after_copy(src)
        if _identity(os.fstat(src)) != _identity(before):
            raise PromoteError(f"changed: {entry.path} hat sich während der Übernahme geändert")
        data = b"".join(chunks)
    finally:
        os.close(src)

    # Schritt 7 und 8: Ziel exklusiv und no-follow anlegen.
    dest_dir = _walk_dest(artifacts_fd, parts[:-1])
    try:
        try:
            dest = os.open(parts[-1], DEST_FLAGS, 0o600, dir_fd=dest_dir)
        except FileExistsError:
            raise PromoteError(f"dest-exists: {entry.path}") from None
        except OSError as e:
            raise PromoteError(f"dest-not-dir: {entry.path}: {e.strerror}") from None
        try:
            st = os.fstat(dest)
            if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
                raise PromoteError(f"dest-not-dir: {entry.path} ist kein neues reguläres Ziel")
            _write_all(dest, data)
        except BaseException:
            os.close(dest)
            os.unlink(parts[-1], dir_fd=dest_dir)
            raise
        os.close(dest)
    finally:
        os.close(dest_dir)
    return len(data)


def promote_all(
    scratch_fd: int,
    artifacts_fd: int,
    manifest: Manifest,
    *,
    _after_copy: Optional[Callable[[int], None]] = None,
) -> list:
    """Übernimmt jeden Eintrag der Allowlist einzeln (Schritt 10 und 11)."""
    results = []
    if not platform_supported():
        return [Result(e.path, "rejected", "unsupported-platform: dir_fd oder O_NOFOLLOW fehlt", 0) for e in manifest.files]
    remaining = manifest.max_total_bytes
    for entry in manifest.files:
        try:
            n = promote_file(scratch_fd, artifacts_fd, entry, remaining, _after_copy=_after_copy)
        except PromoteError as e:
            results.append(Result(entry.path, "rejected", str(e), 0))
            continue
        remaining -= n
        results.append(Result(entry.path, "promoted", None, n))
    return results
