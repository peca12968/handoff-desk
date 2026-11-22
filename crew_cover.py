"""Assign event crew and minimize roster disruption when a published baseline is supplied."""
import argparse
import json
from pathlib import Path

from ortools.sat.python import cp_model


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate key: {key}")
        result[key] = value
    return result


def identifier(value):
    return isinstance(value, str) and bool(value.strip())


def integer(value, minimum=0):
    return type(value) is int and minimum <= value <= 2**31 - 1


def validate(plan):
    if not isinstance(plan, dict) or set(plan) != {"shifts", "crew"}:
        raise ValueError("expected shifts and crew objects")
    shifts, crew = plan["shifts"], plan["crew"]
    if not all(isinstance(group, dict) and all(map(identifier, group)) for group in (shifts, crew)):
        raise ValueError("shifts and crew require named records")
    for name, shift in shifts.items():
        if (not isinstance(shift, dict) or set(shift) != {"start", "end", "need", "skill"}
                or not integer(shift["start"]) or not integer(shift["end"], shift["start"] + 1)
                or not integer(shift["need"], 1) or not identifier(shift["skill"])):
            raise ValueError(f"invalid shift: {name}")
    for name, worker in crew.items():
        if (not isinstance(worker, dict) or set(worker) != {"skills", "budget_minutes", "bids"}
                or not integer(worker["budget_minutes"]) or not isinstance(worker["skills"], list)
                or not all(map(identifier, worker["skills"])) or not isinstance(worker["bids"], dict)
                or not worker["bids"].keys() <= shifts.keys()
                or not all(integer(value) for value in worker["bids"].values())):
            raise ValueError(f"invalid crew record: {name}")


def previous_assignments(baseline):
    if not isinstance(baseline, dict) or not isinstance(baseline.get("shifts"), dict):
        raise ValueError("baseline must contain a shifts object")
    by_person = {}
    for name, row in baseline["shifts"].items():
        if not identifier(name) or not isinstance(row, dict):
            raise ValueError("invalid baseline shift")
        people = row.get("assigned")
        if (not isinstance(people, list) or not all(map(identifier, people))
                or len(set(people)) != len(people)):
            raise ValueError(f"invalid baseline assignments: {name}")
        for person in people:
            by_person.setdefault(person, set()).add(name)
    return by_person


def changed_people(model, candidates, previous):
    # A change anywhere in one person's roster counts once, including lost eligibility.
    differences = {person: [] for person in previous}
    for name, options in candidates.items():
        for person, choice in options.items():
            was_assigned = name in previous.get(person, ())
            differences.setdefault(person, []).append(1 - choice if was_assigned else choice)
    changed = []
    for person, terms in differences.items():
        if any(person not in candidates.get(name, {}) for name in previous.get(person, ())):
            changed.append(1)
        else:
            flag = model.new_bool_var(f"changed/{person}")
            model.add_max_equality(flag, terms)
            changed.append(flag)
    return sum(changed)


def solve(plan, absent=(), baseline=None):
    validate(plan)
    shifts, crew = plan["shifts"], plan["crew"]
    absent = set(absent)
    if unknown := absent - crew.keys():
        raise ValueError(f"unknown absent crew: {', '.join(sorted(unknown))}")
    previous = previous_assignments(baseline) if baseline is not None else None
    model = cp_model.CpModel()
    candidates = {name: {} for name in shifts}
    penalties = []
    for person, worker in crew.items():
        if person in absent:
            continue
        intervals, minutes = [], []
        for name, cost in worker["bids"].items():
            shift = shifts[name]
            if shift["skill"] not in worker["skills"]:
                continue
            duration = shift["end"] - shift["start"]
            assigned = model.new_bool_var(f"{person}/{name}")
            candidates[name][person] = assigned
            intervals.append(model.new_optional_fixed_size_interval_var(
                shift["start"], duration, assigned, f"work/{person}/{name}"))
            minutes.append(duration * assigned)
            penalties.append(cost * assigned)
        model.add_no_overlap(intervals)
        model.add(sum(minutes) <= worker["budget_minutes"])
    for name, options in candidates.items():
        model.add(sum(options.values()) <= shifts[name]["need"])
    coverage = sum(choice for options in candidates.values() for choice in options.values())
    cost = sum(penalties)
    solver = cp_model.CpSolver()
    solver.parameters.num_workers = 1
    model.maximize(coverage)
    require_optimal(solver, model)
    filled = solver.value(coverage)
    model.add(coverage == filled)
    if previous is not None:
        changes = changed_people(model, candidates, previous)
        model.minimize(changes)
        require_optimal(solver, model)
        model.add(changes == solver.value(changes))
    model.minimize(cost)
    require_optimal(solver, model)
    rows = {}
    for name, options in candidates.items():
        assigned = sorted(person for person, choice in options.items() if solver.value(choice))
        rows[name] = {"assigned": assigned, "vacant": shifts[name]["need"] - len(assigned)}
    result = {"filled": filled, "requested": sum(s["need"] for s in shifts.values()),
              "penalty": solver.value(cost), "shifts": rows}
    if previous is not None:
        current = previous_assignments(result)
        changes_by_person = {}
        for person in sorted(previous.keys() | current.keys()):
            old = previous.get(person, set())
            new = current.get(person, set())
            if old != new:
                changes_by_person[person] = {"removed": sorted(old - new), "added": sorted(new - old)}
        result["changes"] = {"people": len(changes_by_person), "by_person": changes_by_person}
    return result


def require_optimal(solver, model):
    status = solver.solve(model)
    if status != cp_model.OPTIMAL:
        raise ValueError(f"optimization ended without proof: {solver.status_name(status)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", type=Path)
    parser.add_argument("--absent", action="append", default=[], metavar="PERSON")
    parser.add_argument("--baseline", type=Path, help="Published roster JSON from a previous run")
    args = parser.parse_args()
    try:
        plan = json.loads(args.plan.read_text(encoding="utf-8"), object_pairs_hook=unique_keys)
        baseline = None
        if args.baseline is not None:
            baseline = json.loads(args.baseline.read_bytes(), object_pairs_hook=unique_keys)
            if baseline is None:
                raise ValueError("baseline must contain a shifts object")
        result = solve(plan, args.absent, baseline)
    except (OSError, ValueError) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
