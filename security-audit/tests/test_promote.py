"""Tests für promote.py. Sie laufen ohne Docker.

Die Testdaten liegen unter ~/security-audit-skill/_test/, nicht unter /tmp.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import promote  # noqa: E402
from promote import Entry, Manifest, PromoteError  # noqa: E402

TEST_ROOT = os.path.join(os.path.expanduser("~"), "security-audit-skill", "_test")


class Fixture(unittest.TestCase):
    def setUp(self) -> None:
        self.base = os.path.join(TEST_ROOT, f"promote-{os.getpid()}-{self._testMethodName}")
        shutil.rmtree(self.base, ignore_errors=True)
        self.scratch = os.path.join(self.base, "scratch")
        self.artifacts = os.path.join(self.base, "artifacts")
        os.makedirs(os.path.join(self.scratch, "out"))
        os.makedirs(self.artifacts)
        self.scratch_fd = os.open(self.scratch, os.O_RDONLY | os.O_DIRECTORY)
        self.artifacts_fd = os.open(self.artifacts, os.O_RDONLY | os.O_DIRECTORY)

    def tearDown(self) -> None:
        os.close(self.scratch_fd)
        os.close(self.artifacts_fd)
        shutil.rmtree(self.base, ignore_errors=True)

    def write(self, rel: str, data: bytes) -> str:
        path = os.path.join(self.scratch, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def promote(self, rel: str, max_bytes: int = 1024, remaining: int = 1 << 20, **kw) -> int:
        return promote.promote_file(self.scratch_fd, self.artifacts_fd, Entry(rel, max_bytes), remaining, **kw)

    def assert_rejected(self, code: str, rel: str, **kw) -> None:
        with self.assertRaises(PromoteError) as ctx:
            self.promote(rel, **kw)
        self.assertTrue(str(ctx.exception).startswith(code + ":"), str(ctx.exception))

    def dest(self, rel: str) -> str:
        return os.path.join(self.artifacts, rel)


class PromoteFileTest(Fixture):
    def test_promotes_regular_file(self) -> None:
        self.write("out/a.txt", b"hallo")
        self.assertEqual(self.promote("out/a.txt"), 5)
        with open(self.dest("out/a.txt"), "rb") as f:
            self.assertEqual(f.read(), b"hallo")
        results = promote.promote_all(self.scratch_fd, self.artifacts_fd, Manifest((), 10))
        self.assertEqual(results, [])

    def test_promote_all_reports_promoted(self) -> None:
        self.write("out/a.txt", b"hallo")
        results = promote.promote_all(self.scratch_fd, self.artifacts_fd, Manifest((Entry("out/a.txt", 10),), 10))
        self.assertEqual([(r.path, r.status, r.bytes) for r in results], [("out/a.txt", "promoted", 5)])

    def test_rejects_invalid_paths(self) -> None:
        for rel in ["", "/etc/passwd", ".", "../x", "out/../x", "out//x", "out/./x", "out/\0x"]:
            with self.subTest(rel=rel):
                with self.assertRaises(PromoteError) as ctx:
                    promote.split_rel_path(rel)
                self.assertTrue(str(ctx.exception).startswith("invalid-path:"))

    def test_rejects_symlink_leaf(self) -> None:
        os.symlink("/etc/hosts", os.path.join(self.scratch, "out/l"))
        self.assert_rejected("symlink", "out/l")
        self.assertFalse(os.path.lexists(self.dest("out/l")))

    def test_rejects_symlink_parent(self) -> None:
        real = os.path.join(self.scratch, "real")
        os.makedirs(real)
        self.write("real/a.txt", b"x")
        os.symlink(real, os.path.join(self.scratch, "out/sub"))
        self.assert_rejected("symlink", "out/sub/a.txt")

    def test_rejects_hardlink(self) -> None:
        src = self.write("out/a.txt", b"x")
        os.link(src, os.path.join(self.scratch, "out/h"))
        self.assert_rejected("hardlink", "out/h")

    def test_rejects_fifo_without_blocking(self) -> None:
        os.mkfifo(os.path.join(self.scratch, "out/f"))

        def timeout(signum, frame):  # pragma: no cover - nur bei Fehler
            raise AssertionError("promote_file blockiert auf einer FIFO")

        old = signal.signal(signal.SIGALRM, timeout)
        signal.alarm(5)
        try:
            self.assert_rejected("not-regular", "out/f")
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old)

    def test_rejects_directory(self) -> None:
        os.makedirs(os.path.join(self.scratch, "out/d"))
        self.assert_rejected("not-regular", "out/d")

    def test_rejects_per_file_limit(self) -> None:
        self.write("out/a.txt", b"x" * 11)
        self.assert_rejected("too-large", "out/a.txt", max_bytes=10)
        self.assertFalse(os.path.lexists(self.dest("out/a.txt")))

    def test_rejects_total_limit(self) -> None:
        self.write("out/a.txt", b"x" * 6)
        self.write("out/b.txt", b"y" * 6)
        manifest = Manifest((Entry("out/a.txt", 10), Entry("out/b.txt", 10)), 10)
        results = promote.promote_all(self.scratch_fd, self.artifacts_fd, manifest)
        self.assertEqual(results[0].status, "promoted")
        self.assertEqual(results[1].status, "rejected")
        self.assertTrue(results[1].reason.startswith("total-exceeded:"))
        self.assertFalse(os.path.lexists(self.dest("out/b.txt")))

    def test_rejects_change_during_copy(self) -> None:
        path = self.write("out/a.txt", b"hallo")

        def grow(src_fd: int) -> None:
            with open(path, "ab") as f:
                f.write(b"!")

        manifest = Manifest((Entry("out/a.txt", 100),), 100)
        results = promote.promote_all(self.scratch_fd, self.artifacts_fd, manifest, _after_copy=grow)
        self.assertEqual(results[0].status, "rejected")
        self.assertTrue(results[0].reason.startswith("changed:"), results[0].reason)
        self.assertFalse(os.path.lexists(self.dest("out/a.txt")))

    def test_rejects_existing_destination(self) -> None:
        self.write("out/a.txt", b"neu")
        os.makedirs(self.dest("out"))
        with open(self.dest("out/a.txt"), "wb") as f:
            f.write(b"alt")
        self.assert_rejected("dest-exists", "out/a.txt")
        with open(self.dest("out/a.txt"), "rb") as f:
            self.assertEqual(f.read(), b"alt")

    def test_rejects_symlink_in_destination_parent(self) -> None:
        self.write("out/a.txt", b"x")
        elsewhere = os.path.join(self.base, "elsewhere")
        os.makedirs(elsewhere)
        os.symlink(elsewhere, self.dest("out"))
        with self.assertRaises(PromoteError) as ctx:
            self.promote("out/a.txt")
        self.assertTrue(str(ctx.exception).split(":")[0] in ("dest-not-dir", "symlink"), str(ctx.exception))
        self.assertEqual(os.listdir(elsewhere), [])

    def test_missing_file_is_rejected_others_promoted(self) -> None:
        self.write("out/a.txt", b"x")
        manifest = Manifest((Entry("out/missing", 10), Entry("out/a.txt", 10)), 100)
        results = promote.promote_all(self.scratch_fd, self.artifacts_fd, manifest)
        self.assertEqual(results[0].status, "rejected")
        self.assertTrue(results[0].reason.startswith("missing:"))
        self.assertEqual(results[1].status, "promoted")


class ManifestTest(Fixture):
    def load(self, data: object) -> Manifest:
        path = os.path.join(self.base, "manifest.json")
        with open(path, "w") as f:
            json.dump(data, f)
        return promote.load_manifest(path)

    def test_load_manifest_reads_entries(self) -> None:
        m = self.load({"max_total_bytes": 20, "files": [{"path": "out/a.txt", "max_bytes": 10}]})
        self.assertEqual(m, Manifest((Entry("out/a.txt", 10),), 20))

    def test_load_manifest_rejects_duplicates_and_bad_limits(self) -> None:
        bad = [
            {"max_total_bytes": 20, "files": [{"path": "a", "max_bytes": 1}, {"path": "a", "max_bytes": 1}]},
            {"max_total_bytes": 0, "files": []},
            {"max_total_bytes": 20, "files": [{"path": "a", "max_bytes": 0}]},
            {"max_total_bytes": 20, "files": [{"path": "a"}]},
            {"files": []},
            {"max_total_bytes": 20, "files": [{"path": "../a", "max_bytes": 1}]},
            {"max_total_bytes": True, "files": []},
        ]
        for data in bad:
            with self.subTest(data=data):
                with self.assertRaises(ValueError):
                    self.load(data)


if __name__ == "__main__":
    unittest.main()
