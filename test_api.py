from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import os
from pathlib import Path
import re
import subprocess
import tempfile
from threading import Barrier
import time
import unittest
from uuid import uuid4

from demo import request, walkthrough

DLL = Path(__file__).resolve().parent / "src/bin/Release/net10.0/HandoffNotes.dll"


@contextmanager
def server(directory):
    logfile = Path(directory) / f"{uuid4()}.log"
    with logfile.open("wb") as output:
        env = {**os.environ, "HANDOFF_DB": str(Path(directory) / "notes.db"),
               "ASPNETCORE_ENVIRONMENT": "Production"}
        process = subprocess.Popen(["dotnet", DLL, "--urls", "http://127.0.0.1:0"],
                                   env=env, stdout=output, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 30
            while process.poll() is None and time.monotonic() < deadline:
                logs = logfile.read_text(encoding="utf-8", errors="replace")
                match = re.search(r"Now listening on: (http://127\.0\.0\.1:\d+)", logs)
                if match:
                    yield match[1]
                    return
                time.sleep(0.05)
            raise RuntimeError(logfile.read_text(encoding="utf-8", errors="replace"))
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


class NoteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = cls.enterClassContext(tempfile.TemporaryDirectory())
        cls.base = cls.enterClassContext(server(cls.directory))

    def create(self, body=b"first"):
        status, headers, _ = request(self.base, "POST", "/notes", body)
        self.assertEqual(status, 201)
        return headers["Location"], headers["ETag"]

    def test_walkthrough_preserves_both_edits(self):
        self.assertEqual(walkthrough(self.base)["revision"], 3)

    def test_concurrent_writers_across_two_server_processes(self):
        note, tag = self.create()
        gate = Barrier(12)
        with server(self.directory) as other:
            def write(i):
                gate.wait(timeout=10)
                data = f"editor {i}".encode()
                status = request([self.base, other][i % 2], "PUT", note, data, {"If-Match": tag})[0]
                return status, data
            with ThreadPoolExecutor(max_workers=12) as pool:
                outcomes = list(pool.map(write, range(12)))
        self.assertCountEqual([status for status, _ in outcomes], [204] + [412] * 11)
        winner = next(body for status, body in outcomes if status == 204)
        status, headers, final = request(self.base, "GET", note)
        self.assertEqual((status, headers["Handoff-Revision"], final), (200, "2", winner))
        self.assertEqual(request(self.base, "GET", note + "/revisions/3")[0], 404)

    def test_weak_read_strong_write_and_lists(self):
        note, tag = self.create()
        for value in ["*", "W/" + tag, '"other,tag", W/' + tag]:
            status, fields, data = request(self.base, "GET", note, headers={"If-None-Match": value})
            self.assertEqual((status, fields["ETag"], data), (304, tag, b""))
        self.assertEqual(request(self.base, "PUT", note, b"x", {"If-Match": "W/" + tag})[0], 412)
        self.assertEqual(request(self.base, "PUT", note, b"x", {"If-Match": tag, "If-None-Match": "*"})[0], 412)
        self.assertEqual(request(self.base, "PUT", note, b"x", {"If-Match": '"other,tag", ' + tag})[0], 204)

    def test_conditional_restore_creates_new_version_and_preserves_history(self):
        original = "\ufeff交班\r\n".encode()
        note, first = self.create(original)
        _, fields, _ = request(self.base, "PUT", note, b"amended", {"If-Match": first})
        second = fields["ETag"]
        def restore(tag, body=b'{"restoreRevision":1}'):
            headers = {"Content-Type": "application/json"}
            if tag: headers["If-Match"] = tag
            return request(self.base, "PATCH", note, body, headers)
        self.assertEqual(restore(None)[0], 428)
        self.assertEqual(restore(first)[0], 412)
        self.assertEqual(restore(second, b'{"restoreRevision":8}')[0], 404)
        for body in [b'{}', b'{"restoreRevision":0}', b'{"restoreRevision":"1"}', b'{"restoreRevision":1,"x":0}']:
            self.assertEqual(restore(second, body)[0], 400)
        code, fields, _ = restore(second)
        third = fields["ETag"]
        self.assertEqual((code, fields["Handoff-Revision"]), (204, "3"))
        self.assertNotIn(third, (first, second))
        self.assertEqual(restore(third)[1]["ETag"], third)
        self.assertEqual(restore(second)[0], 412)
        for n, tag, body in [(1, first, original), (2, second, b"amended"), (3, third, original)]:
            status, headers, data = request(self.base, "GET", f"{note}/revisions/{n}")
            self.assertEqual((status, headers["ETag"], data), (200, tag, body))
        self.assertEqual(request(self.base, "GET", note + "/revisions/4")[0], 404)

    def test_missing_wildcard_malformed_and_other_notes_token(self):
        note, tag = self.create()
        _, other = self.create()
        for value, expected in [(None, 428), ("*", 428), ("unquoted", 400), ('*, ' + tag, 400), (other, 412)]:
            with self.subTest(value=value):
                status, fields, _ = request(self.base, "PUT", note, b"bad", {"If-Match": value} if value else {})
                self.assertEqual(status, expected)
                self.assertEqual(fields["Cache-Control"], "no-store")
        self.assertEqual(request(self.base, "GET", note)[1]["ETag"], tag)

    def test_restore_races_with_new_edit_on_separate_process(self):
        note, first = self.create(b"old")
        _, fields, _ = request(self.base, "PUT", note, b"current", {"If-Match": first})
        cond = {"If-Match": fields["ETag"]}
        gate = Barrier(2)
        with server(self.directory) as other:
            def send(base, method, body, headers):
                gate.wait(timeout=10)
                return request(base, method, note, body, headers)[0]
            with ThreadPoolExecutor(max_workers=2) as pool:
                restored = pool.submit(send, self.base, "PATCH", b'{"restoreRevision":1}',
                                       {**cond, "Content-Type": "application/json"})
                edited = pool.submit(send, other, "PUT", b"new edit", cond)
                statuses = [restored.result(), edited.result()]
        self.assertCountEqual(statuses, [204, 412])
        _, latest, body = request(self.base, "GET", note)
        self.assertEqual((latest["Handoff-Revision"], body), ("3", b"old" if statuses[0] == 204 else b"new edit"))
        self.assertEqual(request(self.base, "GET", note + "/revisions/2")[2], b"current")

    def test_body_round_trip_and_noop_keeps_revision(self):
        body = "\ufeff中文 café\r\n末行\n".encode()
        note, tag = self.create(body)
        status, fields, _ = request(self.base, "PUT", note, body, {"If-Match": tag})
        self.assertEqual((status, fields["ETag"], fields["Handoff-Revision"]), (204, tag, "1"))
        self.assertEqual(request(self.base, "GET", note)[2], body)
        self.assertEqual(request(self.base, "GET", note + "/revisions/2")[0], 404)

    def test_returning_to_original_text_does_not_reactivate_old_tag(self):
        note, tag1 = self.create(b"A")
        _, v2, _ = request(self.base, "PUT", note, b"B", {"If-Match": tag1})
        _, v3, _ = request(self.base, "PUT", note, b"A", {"If-Match": v2["ETag"]})
        self.assertNotEqual(v3["ETag"], tag1)
        self.assertEqual(request(self.base, "PUT", note, b"stale", {"If-Match": tag1})[0], 412)
        self.assertEqual(request(self.base, "GET", note + "/revisions/2")[2], b"B")

    def test_validation_does_not_add_history_and_limits_count_bytes(self):
        note, tag = self.create()
        for data, media, expected in [(b"", "text/plain", 400), (b"\xff", "text/plain", 400),
                                       (b"{}", "application/json", 415), (b"x" * 16385, "text/plain", 413)]:
            self.assertEqual(request(self.base, "PUT", note, data, {"Content-Type": media, "If-Match": tag})[0],
                             expected)
        self.assertEqual(request(self.base, "PUT", note, b"x" * 16384, {"If-Match": tag})[0], 204)
        self.assertEqual(request(self.base, "GET", note)[1]["Handoff-Revision"], "2")

    def test_history_and_tags_survive_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            with server(directory) as first:
                _, headers, _ = request(first, "POST", "/notes", b"original")
                note, tag = headers["Location"], headers["ETag"]
                _, changed, _ = request(first, "PUT", note, b"updated", {"If-Match": tag})
            with server(directory) as restarted:
                _, latest, data = request(restarted, "GET", note)
                self.assertEqual((latest["ETag"], data), (changed["ETag"], b"updated"))
                _, history, data = request(restarted, "GET", note + "/revisions/1")
                self.assertEqual((history["ETag"], data), (tag, b"original"))
