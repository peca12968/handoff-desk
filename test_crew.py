import copy
import itertools
import json
from pathlib import Path
import random
import subprocess
import sys
import unittest

from crew_cover import solve


ROOT = Path(__file__).resolve().parent
EXAMPLE = ROOT / "examples/conference.json"


def evaluate(plan, assignments, absent):
    """Score a complete roster independently by marking every occupied minute."""
    busy = {person: set() for person in plan["crew"]}
    filled = penalty = 0
    for name, people in assignments.items():
        shift = plan["shifts"][name]
        occupied = set(range(shift["start"], shift["end"]))
        if len(people) > shift["need"] or len(set(people)) != len(people):
            return None
        for person in people:
            worker = plan["crew"][person]
            if (person in absent or shift["skill"] not in worker["skills"]
                    or name not in worker["bids"] or occupied & busy[person]):
                return None
            busy[person].update(occupied)
            if len(busy[person]) > worker["budget_minutes"]:
                return None
            filled += 1
            penalty += worker["bids"][name]
    return filled, -penalty


def exhaustive(plan, absent):
    groups = []
    for shift in plan["shifts"].values():
        limit = min(len(plan["crew"]), shift["need"])
        groups.append([team for n in range(limit + 1)
                       for team in itertools.combinations(plan["crew"], n)])
    best = (0, 0)
    for teams in itertools.product(*groups):
        assignments = dict(zip(plan["shifts"], teams, strict=True))
        score = evaluate(plan, assignments, absent)
        if score is not None:
            best = max(best, score)
    return best


def small_plan(rng):
    shifts = {}
    for i in range(rng.randint(1, 4)):
        start = rng.randrange(5)
        shifts[str(i)] = {"start": start, "end": start + rng.randint(1, 3),
                          "need": rng.randint(1, 2), "skill": rng.choice(["a", "b"])}
    crew = {person: {"skills": [s for s in ("a", "b") if rng.random() < .75],
                     "budget_minutes": rng.randrange(8),
                     "bids": {s: rng.randrange(6) for s in shifts if rng.random() < .8}}
            for person in ("X", "Y", "Z")}
    return {"shifts": shifts, "crew": crew}


class CrewTest(unittest.TestCase):
    def test_random_plans_match_exhaustive_search(self):
        rng = random.Random(408)
        for i in range(100):
            with self.subTest(case=i):
                plan = small_plan(rng)
                absent = {"Z"} if i % 3 == 0 else set()
                result = solve(plan, absent)
                rows = result["shifts"]
                self.assertEqual(rows.keys(), plan["shifts"].keys())
                roster = {name: row["assigned"] for name, row in rows.items()}
                score = (result["filled"], -result["penalty"])
                self.assertEqual(evaluate(plan, roster, absent), score)
                self.assertEqual(exhaustive(plan, absent), score)
                self.assertEqual(result["requested"], sum(s["need"] for s in plan["shifts"].values()))
                for name, row in rows.items():
                    self.assertEqual(len(row["assigned"]) + row["vacant"], plan["shifts"][name]["need"])

    def test_conference_cli(self):
        for flags, expected, captions in [([], (6, 6, 9), ["mei"]), (["--absent", "bao"], (5, 6, 5), [])]:
            result = subprocess.run([sys.executable, ROOT / "crew_cover.py", EXAMPLE, *flags],
                                    check=True, capture_output=True, text=True)
            data = json.loads(result.stdout)
            self.assertEqual((data["filled"], data["requested"], data["penalty"]), expected)
            self.assertEqual(data["shifts"]["captions"]["assigned"], captions)
            self.assertEqual(data["shifts"]["captions"]["vacant"], 1 - len(captions))

    def test_coverage_wins_even_with_costly_assignment(self):
        plan = json.loads(EXAMPLE.read_text())
        plan["crew"]["bao"]["bids"]["broadcast"] = 2_000_000_000
        result = solve(plan)
        self.assertEqual((result["filled"], result["penalty"]), (6, 2_000_000_006))

    def test_empty_demand_and_no_eligible_people(self):
        plan = {"shifts": {}, "crew": {}}
        self.assertEqual(solve(plan), {"filled": 0, "requested": 0, "penalty": 0, "shifts": {}})
        plan["shifts"]["r"] = {"start": 0, "end": 1, "skill": "a", "need": 2}
        self.assertEqual(solve(plan)["shifts"]["r"], {"assigned": [], "vacant": 2})

    def test_input_errors(self):
        base = json.loads(EXAMPLE.read_text())
        for name, value in (("end", 0), ("start", True), ("need", 0)):
            invalid = copy.deepcopy(base)
            invalid["shifts"]["registration"][name] = value
            with self.assertRaises(ValueError):
                solve(invalid)
        with self.assertRaisesRegex(ValueError, "unknown absent"):
            solve(base, ["nobody"])
        base["crew"]["mei"]["bids"]["unlisted"] = 0
        with self.assertRaisesRegex(ValueError, "invalid crew"):
            solve(base)


if __name__ == "__main__":
    unittest.main()
