"""Export one selected Overlap Hours result as an iCalendar event."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
from tempfile import NamedTemporaryFile


INSTANT = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:00)?(Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])")


def instant(value):
    if not isinstance(value, str) or not INSTANT.fullmatch(value):
        raise ValueError("expected a whole-minute ISO timestamp with an explicit UTC offset")
    return datetime.fromisoformat(value)


def text_value(value, field):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must contain text")
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    if any((ord(char) < 32 and char not in "\t\n") or ord(char) == 127 for char in value):
        raise ValueError(f"{field} contains a control character")
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace(",", "\\,").replace(";", "\\;")


def fold(line):
    chunks = []
    part = bytearray()
    for char in line:
        octets = char.encode("utf-8")
        if len(part) + len(octets) > 75:
            chunks.append(bytes(part))
            part = bytearray(b" ")
        part.extend(octets)
    chunks.append(bytes(part))
    return b"\r\n".join(chunks)


def utc_stamp(value):
    utc = value.astimezone(timezone.utc).replace(tzinfo=None, microsecond=0)
    return utc.isoformat(timespec="seconds").replace("-", "").replace(":", "") + "Z"


def select_slot(report, selected):
    if not isinstance(report, dict) or not isinstance(report.get("slots"), list):
        raise ValueError("expected a search result with a slots array")
    found = []
    for slot in report["slots"]:
        if not isinstance(slot, dict):
            raise ValueError("invalid slot")
        if instant(slot.get("start")) == selected:
            found.append(slot)
    if len(found) != 1:
        raise ValueError(f"selected start must match exactly one returned slot; found {len(found)}")
    return found[0]


def render(slot, title, uid, revision):
    start, end = instant(slot.get("start")), instant(slot.get("end"))
    if end <= start:
        raise ValueError("slot must end after it starts")
    if not 0 <= revision <= 2**31 - 1:
        raise ValueError("revision must be between 0 and 2147483647")
    if not isinstance(slot.get("local"), list) or not slot["local"]:
        raise ValueError("selected slot has an empty or missing local roster")
    if not uid or any(char.isspace() for char in uid):
        raise ValueError("UID must be a nonempty identifier without whitespace")
    roster = ["可全程出席"]
    seen = set()
    for person in slot["local"]:
        if not isinstance(person, dict):
            raise ValueError("invalid local roster entry")
        name, zone = person.get("id"), person.get("zone")
        for label, value in [("id", name), ("zone", zone)]:
            if not isinstance(value, str) or not value.strip() or "\r" in value or "\n" in value:
                raise ValueError(f"participant {label} must be a single nonempty line")
        if name in seen:
            raise ValueError("duplicate participant ID")
        seen.add(name)
        local_start, local_end = instant(person.get("start")), instant(person.get("end"))
        if local_start != start or local_end != end:
            raise ValueError(f"local times disagree with the selected slot for {name}")
        roster.append(f"{name} ({zone})  {local_start.isoformat(timespec='minutes')} – {local_end.isoformat(timespec='minutes')}")
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//peca12968//Slot Calendar//ZH-TW", "BEGIN:VEVENT",
        "UID:" + text_value(uid, "UID"), "DTSTAMP:" + utc_stamp(datetime.now(timezone.utc)),
        "DTSTART:" + utc_stamp(start), "DTEND:" + utc_stamp(end), f"SEQUENCE:{revision}",
        "SUMMARY:" + text_value(title, "title"), "DESCRIPTION:" + text_value("\n".join(roster), "roster"),
        "END:VEVENT", "END:VCALENDAR",
    ]
    return b"\r\n".join(fold(line) for line in lines) + b"\r\n"


def publish(destination, content):
    temp = NamedTemporaryFile(dir=destination.parent, delete=False)
    staging = Path(temp.name)
    try:
        with temp:
            temp.write(content)
        os.replace(staging, destination)
    finally:
        staging.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path, help="JSON response from /availability/search")
    parser.add_argument("--start", required=True, help="select by offset-qualified instant")
    parser.add_argument("--title", required=True)
    parser.add_argument("--uid", required=True, help="stable, globally unique meeting identifier")
    parser.add_argument("--revision", type=int, default=0, help="iCalendar SEQUENCE (default 0)")
    parser.add_argument("-o", "--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.report.resolve() == args.output.resolve() or (args.output.exists() and args.report.samefile(args.output)):
            raise ValueError("output also names the input report")
        data = json.loads(args.report.read_text(encoding="utf-8-sig"))
        slot = select_slot(data, instant(args.start))
        publish(args.output, render(slot, args.title, args.uid, args.revision))
    except (OSError, ValueError, OverflowError) as error:
        print(error, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
