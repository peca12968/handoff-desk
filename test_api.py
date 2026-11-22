"""Exercise the compiled API over a real loopback HTTP connection."""
import copy
from datetime import datetime, timedelta, timezone
from http.client import HTTPConnection
import json
import os
from pathlib import Path
import re
import random
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parent
EXAMPLE = ROOT / "examples/taipei-new-york.json"


def scenario(start, end, zone, days, shift_start, shift_end, duration=30, step=30):
    return {
        "start": start, "end": end, "durationMinutes": duration, "stepMinutes": step,
        "participants": [{"id": "p", "zone": zone,
                          "working": [{"days": days, "start": shift_start, "end": shift_end}]}],
    }


def iso(value):
    return datetime.fromisoformat(value).astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M")


class AvailabilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(temp.cleanup)
        logfile = Path(temp.name) / "server.log"
        log = logfile.open("wb")
        cls.addClassCleanup(log.close)
        dll = ROOT / "src/bin/Release/net10.0/overlap-hours.dll"
        server = subprocess.Popen(["dotnet", str(dll), "--urls", "http://127.0.0.1:0"],
                                  cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                                  env=dict(os.environ, ASPNETCORE_ENVIRONMENT="Production"))

        def shutdown():
            if server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)
        cls.addClassCleanup(shutdown)
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline and server.poll() is None:
            match = re.search(r"Now listening on: http://127\.0\.0\.1:(\d+)",
                              logfile.read_text(encoding="utf-8", errors="replace"))
            if match:
                cls.port = int(match[1])
                return
            time.sleep(.05)
        raise RuntimeError(logfile.read_text(encoding="utf-8", errors="replace"))

    def post(self, value, expected=200):
        conn = HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request("POST", "/availability/search", json.dumps(value).encode(),
                         {"Content-Type": "application/json"})
            response = conn.getresponse()
            body = response.read()
            self.assertEqual(response.status, expected, body)
            return json.loads(body)
        finally:
            conn.close()

    def test_two_cities_two_busy_intervals(self):
        data = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        report = self.post(data)
        self.assertEqual(report["totalSlots"], 2)
        self.assertEqual([iso(s["start"]) for s in report["slots"]],
                         ["2024-11-04 13:00", "2024-11-04 14:00"])
        first = report["slots"][0]["local"]
        self.assertEqual(first[0]["start"], "2024-11-04T21:00:00+08:00")
        self.assertEqual(first[1]["start"], "2024-11-04T08:00:00-05:00")

    def test_spring_gap_uses_elapsed_duration(self):
        query = scenario("2024-03-10T05:00Z", "2024-03-10T09:00Z", "America/New_York",
                         [7], "01:30", "03:30", 60, 15)
        report = self.post(query)
        self.assertEqual(report["totalSlots"], 1)
        local = report["slots"][0]["local"][0]
        self.assertEqual(local["start"], "2024-03-10T01:30:00-05:00")
        self.assertEqual(local["end"], "2024-03-10T03:30:00-04:00")

    def test_fall_fold_keeps_both_occurrences_and_busy_blocks_only_one(self):
        query = scenario("2024-11-03T04:00Z", "2024-11-03T08:00Z", "America/New_York",
                         [7], "01:00", "02:00")
        all_slots = self.post(query)["slots"]
        self.assertEqual(len(all_slots), 4)
        starts = [s["local"][0]["start"] for s in all_slots]
        self.assertIn("2024-11-03T01:00:00-04:00", starts)
        self.assertIn("2024-11-03T01:00:00-05:00", starts)
        query["participants"][0]["busy"] = [{"start": "2024-11-03T01:00-04:00", "end": "2024-11-03T01:30-04:00"}]
        remaining = [s["local"][0]["start"] for s in self.post(query)["slots"]]
        self.assertNotIn(starts[0], remaining)
        self.assertEqual(remaining, starts[1:])

    def test_overnight_week_wrap_and_quarter_hour_offset(self):
        query = scenario("2024-11-03T17:30Z", "2024-11-03T19:30Z", "Asia/Kathmandu",
                         [7], "23:30", "01:00", 30, 15)
        report = self.post(query)
        self.assertEqual(report["totalSlots"], 5)
        self.assertEqual(iso(report["slots"][0]["start"]), "2024-11-03 17:45")
        self.assertEqual(report["slots"][-1]["local"][0]["end"], "2024-11-04T01:00:00+05:45")

    def test_grid_is_anchored_to_query_start_and_limit_preserves_total(self):
        query = scenario("2024-11-04T10:07Z", "2024-11-04T11:07Z", "UTC", [1], "10:12", "12:00", 15, 10)
        query["limit"] = 2
        report = self.post(query)
        self.assertEqual(report["totalSlots"], 4)
        self.assertEqual([iso(s["start"]) for s in report["slots"]], ["2024-11-04 10:17", "2024-11-04 10:27"])

    def test_intersected_busy_spans_and_empty_rules(self):
        query = scenario("2024-11-04T00:00Z", "2024-11-04T01:00Z", "UTC", [1], "00:00", "24:00", 10, 10)
        query["participants"][0]["busy"] = [
            {"start":"2024-11-03T23:50Z", "end":"2024-11-04T00:20Z"},
            {"start":"2024-11-04T00:10Z", "end":"2024-11-04T00:40Z"}]
        self.assertEqual([iso(s["start"]) for s in self.post(query)["slots"]], ["2024-11-04 00:40", "2024-11-04 00:50"])
        query["participants"].append({"id":"empty", "zone":"UTC", "working":[]})
        self.assertEqual(self.post(query), {"totalSlots":0, "slots":[]})

    def test_invalid_input_returns_client_errors(self):
        valid = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        for update in [{"start":"2024-11-04T12:00"}, {"end":"2025-11-04T12:00Z"},
                       {"stepMinutes":0}, {"durationMinutes":-1}, {"limit":101},
                       {"participants":[valid["participants"][0]] * 2},
                       {"participants":[{"id":"a","zone":"no/such_zone","working":[]}]},
                       {"participants":[None]}]:
            with self.subTest(update=update):
                self.assertIn("error", self.post(valid | update, 400))
        invalid = copy.deepcopy(valid)
        invalid["participants"][0]["working"][0]["days"] = [8]
        self.assertIn("error", self.post(invalid, 400))

    def test_output_agrees_with_interval_intersection_for_twelve_fixed_schedules(self):
        start = datetime(2024, 11, 4, 9, tzinfo=timezone.utc)
        def stamp(minute):
            return (start + timedelta(minutes=minute)).isoformat(timespec="minutes")
        for seed in range(12):
            rng = random.Random(seed)
            duration, step = rng.randint(7, 31), rng.randint(3, 17)
            query = scenario(stamp(0), stamp(180), "UTC", [1], "09:00", "12:00", duration, step)
            working = query["participants"].pop()["working"]
            all_busy = []
            for person_id in ["p", "q"]:
                intervals = [(t, t + rng.randint(2, 17)) for t in rng.sample(range(-10, 181), 3)]
                query["participants"].append({"id": person_id, "zone": "UTC", "working": working,
                                              "busy": [{"start":stamp(a), "end":stamp(b)} for a, b in intervals]})
                all_busy.extend(intervals)
            expected = [minute for minute in range(0, 181 - duration, step)
                        if all(minute + duration <= a or b <= minute for a, b in all_busy)]
            query["limit"] = 100
            result = self.post(query)
            with self.subTest(seed=seed):
                actual = [int((datetime.fromisoformat(s["start"]) - start).total_seconds() // 60)
                          for s in result["slots"]]
                self.assertEqual(result["totalSlots"], len(expected))
                self.assertEqual(actual, expected)
