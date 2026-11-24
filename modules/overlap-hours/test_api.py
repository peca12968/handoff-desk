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

    def test_handoff_requires_the_same_support_person_for_all_45_minutes(self):
        query = json.loads((ROOT / "examples/support-handoff.json").read_text(encoding="utf-8"))
        report = self.post(query)
        self.assertEqual([iso(s["start"])[-5:] for s in report["slots"]], ["13:30", "13:45", "14:00", "14:15"])
        for slot in report["slots"]:
            self.assertEqual([p["id"] for p in slot["local"]], ["design", "engineering", "support-west"])
        query["limit"] = 1
        self.assertEqual(self.post(query), {"totalSlots": 4, "slots": report["slots"][:1]})
        del query["attendance"]
        self.assertEqual(self.post(query), {"totalSlots": 0, "slots": []})

    def test_required_and_optional_at_the_32_person_limit(self):
        query = scenario("2024-11-04T12:00Z", "2024-11-04T12:30Z", "UTC", [1], "12:00", "13:00")
        base = query["participants"][0]
        query["participants"] = [base | {"id": str(i)} for i in range(32)]
        self.assertEqual(len(self.post(query)["slots"][0]["local"]), 32)
        query["participants"][31]["working"] = []
        self.assertEqual(self.post(query)["totalSlots"], 0)
        query["attendance"] = {"optionalIds": ["0", "31"], "minimumOptional": 1}
        self.assertEqual([p["id"] for p in self.post(query)["slots"][0]["local"]], [str(i) for i in range(31)])
        query["attendance"] = {"optionalIds": [str(i) for i in range(32)], "minimumOptional": 32}
        self.assertEqual(self.post(query)["totalSlots"], 0)
        query["attendance"]["minimumOptional"] = 31
        self.assertEqual(self.post(query)["totalSlots"], 1)

    def test_preferred_example_reorders_all_candidates_before_limit(self):
        query = json.loads((ROOT / "examples/preferred-hours.json").read_text(encoding="utf-8"))
        fixture = json.loads((ROOT / "examples/preferred-hours-result.json").read_text(encoding="utf-8"))
        self.assertEqual(self.post(query | {"rankBy": "earliest"}), fixture["earliest"])
        del query["rankBy"]
        self.assertEqual(self.post(query), fixture["earliest"])
        ranked = self.post(query | {"rankBy": "preferred"})
        self.assertEqual(ranked, fixture["preferred"])
        self.assertEqual([iso(slot["start"])[-5:] for slot in ranked["slots"]], ["14:00", "14:15", "13:45", "13:30"])
        self.assertEqual([slot["preference"]["totalOutsideMinutes"] for slot in ranked["slots"]], [0, 0, 30, 60])
        self.assertEqual(self.post(query | {"rankBy": "preferred", "limit": 1}),
                         {"totalSlots": 4, "slots": ranked["slots"][:1]})

    def test_preferred_ranking_preserves_optional_coverage_priority(self):
        query = scenario("2024-11-04T13:00Z", "2024-11-04T14:00Z", "UTC", [1], "13:00", "14:00")
        person = query["participants"][0]
        person["preferred"] = [{"days": [1], "start": "13:00", "end": "13:30"}]
        query["participants"].append({"id": "support", "zone": "UTC", "working": [
            {"days": [1], "start": "13:30", "end": "14:00"}], "preferred": []})
        query["attendance"] = {"optionalIds": ["support"], "minimumOptional": 0}
        ranked = self.post(query | {"rankBy": "preferred"})
        self.assertEqual([len(slot["local"]) for slot in ranked["slots"]], [2, 1])
        self.assertEqual([slot["preference"] for slot in ranked["slots"]], [
            {"maximumOutsideMinutes": 30, "totalOutsideMinutes": 60},
            {"maximumOutsideMinutes": 0, "totalOutsideMinutes": 0},
        ])

    def test_preferred_ranking_minimizes_worst_person_before_the_total(self):
        query = scenario("2024-11-04T13:00Z", "2024-11-04T14:30Z", "UTC", [1], "13:00", "14:30")
        base = query["participants"][0]
        first = [("13:00", "13:30"), ("13:30", "13:50"), ("14:00", "14:20")]
        second = [("13:00", "13:10"), ("13:30", "13:50"), ("14:00", "14:30")]
        query["participants"] = [base | {"id": name, "preferred": [
            {"days": [1], "start": a, "end": b} for a, b in ranges]} for name, ranges in (("one", first), ("two", second))]
        ranked = self.post(query | {"rankBy": "preferred"})
        self.assertEqual([iso(slot["start"])[-5:] for slot in ranked["slots"]], ["14:00", "13:30", "13:00"])
        self.assertEqual([slot["preference"] for slot in ranked["slots"]], [
            {"maximumOutsideMinutes": 10, "totalOutsideMinutes": 10},
            {"maximumOutsideMinutes": 10, "totalOutsideMinutes": 20},
            {"maximumOutsideMinutes": 20, "totalOutsideMinutes": 20},
        ])

    def test_preferred_minutes_count_both_offsets_during_the_repeated_hour(self):
        query = scenario("2024-11-03T05:00Z", "2024-11-03T07:00Z", "America/New_York", [7], "01:00", "02:00", 60, 30)
        query["participants"][0]["preferred"] = [{"days": [7], "start": "01:15", "end": "01:45"}]
        result = self.post(query | {"rankBy": "preferred"})
        self.assertEqual(result["totalSlots"], 3)
        for slot in result["slots"]:
            self.assertEqual(slot["preference"], {"maximumOutsideMinutes": 30, "totalOutsideMinutes": 30})
        middle = result["slots"][1]["local"][0]
        self.assertEqual(middle["start"], "2024-11-03T01:30:00-04:00")
        self.assertEqual(middle["end"], "2024-11-03T01:30:00-05:00")

    def test_invalid_preferred_ranking_returns_400(self):
        query = scenario("2024-11-04T13:00Z", "2024-11-04T14:00Z", "UTC", [1], "13:00", "14:00")
        self.post(query | {"rankBy": "unknown"}, expected=400)
        person = query["participants"][0]
        person["preferred"] = [{"days": [8], "start": "13:00", "end": "13:30"}]
        self.post(query | {"rankBy": "preferred"}, expected=400)

    def test_optional_coverage_in_repeated_hour_uses_actual_instants(self):
        query = scenario("2024-11-03T05:00Z", "2024-11-03T07:00Z", "America/New_York", [7], "01:00", "02:00", 60, 30)
        base = query["participants"][0]
        query["participants"] = [base | {"id": "early", "busy": [{"start": "2024-11-03T06:00Z", "end": "2024-11-03T07:00Z"}]},
                                 base | {"id": "late", "busy": [{"start": "2024-11-03T05:00Z", "end": "2024-11-03T06:00Z"}]}]
        query["attendance"] = {"optionalIds": ["early", "late"], "minimumOptional": 1}
        slots = self.post(query)["slots"]
        self.assertEqual([[p["id"] for p in s["local"]] for s in slots], [["early"], ["late"]])
        self.assertEqual([s["local"][0]["start"] for s in slots],
                         ["2024-11-03T01:00:00-04:00", "2024-11-03T01:00:00-05:00"])

    def test_invalid_quorum_policies_return_400(self):
        query = scenario("2024-11-04T12:00Z", "2024-11-04T13:00Z", "UTC", [1], "00:00", "24:00")
        for ids, minimum in [(["absent"], 1), (["p", "p"], 1), (["p"], 2), (["p"], -1),
                             (["p"], 0), ([None], 1), ([], None), (None, 0)]:
            with self.subTest(ids=ids, minimum=minimum):
                policy = {"optionalIds": ids, "minimumOptional": minimum}
                self.assertIn("error", self.post(query | {"attendance": policy}, 400))

    def test_quorum_matches_interval_oracle_on_64_schedules(self):
        origin = datetime(2024, 11, 4, 10, tzinfo=timezone.utc)
        def stamp(minute):
            return (origin + timedelta(minutes=minute)).isoformat(timespec="minutes")

        for seed in range(64):
            rng = random.Random(seed)
            duration, step = rng.randint(5, 36), rng.randint(3, 13)
            query = scenario(stamp(0), stamp(100), "UTC", [1], "00:00", "24:00", duration, step)
            base = query["participants"].pop()
            blocks = {}
            for name in ["host", "a", "b", "c"]:
                blocks[name] = [(t, t + rng.randint(2, 15)) for t in rng.sample(range(90), rng.randint(0, 4))]
                query["participants"].append(base | {"id": name, "busy": [
                    {"start": stamp(a), "end": stamp(b)} for a, b in blocks[name]]})
            minimum = seed % 4
            query["attendance"] = {"optionalIds": ["c", "a", "b"], "minimumOptional": minimum}
            query["limit"] = 3
            expected = []
            for t in range(0, 101 - duration, step):
                present = [name for name, intervals in blocks.items()
                           if all(t + duration <= a or b <= t for a, b in intervals)]
                if "host" in present and len(present) - 1 >= minimum:
                    expected.append((iso(stamp(t)), present))
            result = self.post(query)
            with self.subTest(seed=seed):
                actual = [(iso(s["start"]), [p["id"] for p in s["local"]]) for s in result["slots"]]
                self.assertEqual((result["totalSlots"], actual), (len(expected), expected[:3]))

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

    def test_date_override_replaces_weekly_hours_and_empty_day_closes(self):
        query = json.loads((ROOT / "examples/special-hours.json").read_text(encoding="utf-8"))
        report = self.post(query)
        self.assertEqual(report["totalSlots"], 1)
        self.assertEqual(iso(report["slots"][0]["start"]), "2024-11-04 14:00")
        query["participants"][0]["overrides"][0]["working"] = []
        self.assertEqual(self.post(query), {"totalSlots": 0, "slots": []})

    def test_local_holiday_cuts_overnight_carry_at_midnight_before_utc_date_changes(self):
        query = scenario("2024-11-03T15:00Z", "2024-11-03T17:00Z", "Asia/Taipei", [7], "23:00", "01:00")
        query["participants"][0]["overrides"] = [{"date": "2024-11-04", "working": []}]
        result = self.post(query)
        self.assertEqual([iso(s["start"]) for s in result["slots"]], ["2024-11-03 15:00", "2024-11-03 15:30"])

    def test_one_off_open_hours_apply_to_both_repeated_hours_but_absolute_busy_still_wins(self):
        query = scenario("2024-11-03T04:00Z", "2024-11-03T08:00Z", "America/New_York", [1], "09:00", "10:00")
        person = query["participants"][0]
        person["overrides"] = [{"date": "2024-11-03", "working": [{"start": "01:00", "end": "01:30"}]}]
        slots = self.post(query)["slots"]
        self.assertEqual([s["local"][0]["start"] for s in slots],
                         ["2024-11-03T01:00:00-04:00", "2024-11-03T01:00:00-05:00"])
        person["busy"] = [{"start": "2024-11-03T01:00-04:00", "end": "2024-11-03T01:30-04:00"}]
        self.assertEqual(self.post(query)["slots"], slots[1:])

    def test_override_ranges_merge_and_the_weekly_schedule_resumes_next_day(self):
        query = scenario("2024-11-04T22:30Z", "2024-11-05T00:30Z", "UTC", [2], "00:00", "00:30",
                         duration=60, step=30)
        query["participants"][0]["overrides"] = [{"date": "2024-11-04", "working": [
            {"start": "23:30", "end": "24:00"}, {"start": "23:00", "end": "23:45"}]}]
        self.assertEqual([iso(s["start"]) for s in self.post(query)["slots"]],
                         ["2024-11-04 23:00", "2024-11-04 23:30"])

    def test_one_off_hours_inside_a_spring_clock_gap_create_no_slot(self):
        query = scenario("2024-03-10T05:00Z", "2024-03-10T09:00Z", "America/New_York", [7], "00:00", "24:00")
        query["participants"][0]["overrides"] = [{"date": "2024-03-10", "working": [
            {"start": "02:00", "end": "03:00"}]}]
        self.assertEqual(self.post(query), {"totalSlots": 0, "slots": []})

    def test_ambiguous_or_invalid_overrides_return_400(self):
        query = json.loads(EXAMPLE.read_text(encoding="utf-8"))
        closed = {"date": "2024-11-04", "working": []}
        for overrides in [[closed, closed], [closed | {"date": "2024-02-30"}], [{"date": "2024-11-04"}],
                          [closed | {"working": [{"start": "23:00", "end": "01:00"}]}], [None]]:
            with self.subTest(overrides=overrides):
                query["participants"][0]["overrides"] = overrides
                self.assertIn("error", self.post(query, 400))

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
