"""Assign qualified event crew to shifts with two exact optimization stages."""
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


def solve(plan, absent=()):
    validate(plan)
    shifts, crew = plan["shifts"], plan["crew"]
    absent = set(absent)
    if unknown := absent - crew.keys():
        raise ValueError(f"unknown absent crew: {', '.join(sorted(unknown))}")
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
    model.minimize(cost)
    require_optimal(solver, model)
    rows = {}
    for name, options in candidates.items():
        assigned = sorted(person for person, choice in options.items() if solver.value(choice))
        rows[name] = {"assigned": assigned, "vacant": shifts[name]["need"] - len(assigned)}
    return {"filled": filled, "requested": sum(s["need"] for s in shifts.values()),
            "penalty": solver.value(cost), "shifts": rows}


def require_optimal(solver, model):
    status = solver.solve(model)
    if status != cp_model.OPTIMAL:
        raise ValueError(f"optimization ended without proof: {solver.status_name(status)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", type=Path)
    parser.add_argument("--absent", action="append", default=[], metavar="PERSON")
    args = parser.parse_args()
    try:
        plan = json.loads(args.plan.read_text(encoding="utf-8"), object_pairs_hook=unique_keys)
        result = solve(plan, args.absent)
    except (OSError, ValueError) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
