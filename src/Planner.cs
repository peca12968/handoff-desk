using System.Globalization;

namespace OverlapHours;

public sealed record SearchRequest(string? Start, string? End, int DurationMinutes, int StepMinutes,
                                   PersonInput?[]? Participants, int? Limit = null);
public sealed record PersonInput(string? Id, string? Zone, Shift?[]? Working, Busy?[]? Busy);
public sealed record Shift(int[]? Days, string? Start, string? End);
public sealed record Busy(string? Start, string? End);
public sealed record LocalSlot(string Id, string Zone, DateTimeOffset Start, DateTimeOffset End);
public sealed record Slot(DateTimeOffset Start, DateTimeOffset End, LocalSlot[] Local);
public sealed record SearchResult(int TotalSlots, Slot[] Slots);
internal sealed record Person(string Id, TimeZoneInfo Zone, bool[] Week, int[] BusyChanges);

public static class Planner
{
    private const int Day = 1440;
    private static readonly string[] InstantFormats = ["yyyy-MM-dd'T'HH:mmzzz", "yyyy-MM-dd'T'HH:mm:sszzz"];

    private static DateTimeOffset Instant(string? value, string field)
    {
        if (value?.EndsWith('Z') == true) value = value[..^1] + "+00:00";
        if (!DateTimeOffset.TryParseExact(value, InstantFormats, CultureInfo.InvariantCulture,
                DateTimeStyles.None, out var parsed) || parsed.Second != 0)
            throw new ArgumentException($"{field} requires an offset-qualified time aligned to a whole minute");
        return parsed.ToUniversalTime();
    }

    private static int WallMinute(string? text, bool allowMidnightEnd)
    {
        if (allowMidnightEnd && text == "24:00") return Day;
        if (!TimeOnly.TryParseExact(text, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var time))
            throw new ArgumentException("Working times require HH:mm; 24:00 is allowed as an end");
        return time.Hour * 60 + time.Minute;
    }

    private static Person Prepare(PersonInput? input, DateTimeOffset start, int minutes)
    {
        if (input is null || string.IsNullOrWhiteSpace(input.Id) || input.Id.Length > 80 ||
            string.IsNullOrWhiteSpace(input.Zone))
            throw new ArgumentException("Each participant requires an ID of 1 to 80 characters and a time zone");
        if (!TimeZoneInfo.TryFindSystemTimeZoneById(input.Zone, out var zone))
            throw new ArgumentException($"Unknown time zone for {input.Id}");
        if (input.Working is null || input.Working.Length > 50 || input.Busy?.Length > 500)
            throw new ArgumentException("Supply up to 50 working rules and 500 busy intervals per person");

        var week = new bool[7 * Day];
        foreach (var shift in input.Working)
        {
            if (shift?.Days is not { Length: >= 1 and <= 7 } days || days.Any(d => d is < 1 or > 7))
                throw new ArgumentException("Working days use ISO weekdays 1 (Monday) through 7 (Sunday)");
            var from = WallMinute(shift.Start, false);
            var until = WallMinute(shift.End, true);
            if (until == from) throw new ArgumentException("A working rule must have a nonzero length");
            if (until < from) until += Day;
            foreach (var weekday in days)
                for (var i = from; i < until; i++)
                    week[((weekday - 1) * Day + i) % week.Length] = true;
        }

        // Prefix sums merge overlapping busy intervals without walking each interval.
        var changes = new int[minutes + 1];
        foreach (var busy in input.Busy ?? [])
        {
            var from = Instant(busy?.Start, "busy.start");
            var until = Instant(busy?.End, "busy.end");
            if (until <= from) throw new ArgumentException("Busy interval end must follow start");
            var first = (int)Math.Clamp((from - start).TotalMinutes, 0, minutes);
            var last = (int)Math.Clamp((until - start).TotalMinutes, 0, minutes);
            changes[first]++;
            changes[last]--;
        }
        return new Person(input.Id, zone, week, changes);
    }

    public static SearchResult Search(SearchRequest request)
    {
        var start = Instant(request.Start, "start");
        var end = Instant(request.End, "end");
        var span = (end - start).TotalMinutes;
        if (span is <= 0 or > (14 * Day)) throw new ArgumentException("Search window must be positive and at most 14 days");
        if (request.DurationMinutes is < 1 or > Day || request.StepMinutes is < 1 or > Day)
            throw new ArgumentException("Duration and step must each be between 1 and 1440 minutes");
        var limit = request.Limit ?? 20;
        if (limit is < 1 or > 100) throw new ArgumentException("Result limit must be between 1 and 100");
        if (request.Participants is not { Length: >= 1 and <= 32 } inputs)
            throw new ArgumentException("Supply 1 to 32 participants");
        var minutes = (int)span;
        var people = inputs.Select(input => Prepare(input, start, minutes)).ToArray();
        if (people.Select(p => p.Id).Distinct(StringComparer.Ordinal).Count() != people.Length)
            throw new ArgumentException("Participant IDs must be unique");

        var free = new bool[minutes];
        Array.Fill(free, true);
        foreach (var person in people)
        {
            var busyCount = 0;
            for (var i = 0; i < minutes; i++)
            {
                busyCount += person.BusyChanges[i];
                if (!free[i]) continue;
                var local = TimeZoneInfo.ConvertTime(start.AddMinutes(i), person.Zone);
                var weekday = ((int)local.DayOfWeek + 6) % 7;
                free[i] = busyCount == 0 && person.Week[weekday * Day + local.Hour * 60 + local.Minute];
            }
        }

        var slots = new List<Slot>();
        var total = 0;
        var run = 0;
        for (var i = 0; i < minutes; i++)
        {
            run = free[i] ? run + 1 : 0;
            if (run < request.DurationMinutes) continue;
            var offset = i + 1 - request.DurationMinutes;
            if (offset % request.StepMinutes != 0) continue;
            total++;
            if (slots.Count == limit) continue;
            var from = start.AddMinutes(offset);
            var until = from.AddMinutes(request.DurationMinutes);
            var locals = people.Select(p => new LocalSlot(p.Id, p.Zone.Id,
                TimeZoneInfo.ConvertTime(from, p.Zone), TimeZoneInfo.ConvertTime(until, p.Zone))).ToArray();
            slots.Add(new Slot(from, until, locals));
        }
        return new SearchResult(total, slots.ToArray());
    }
}
