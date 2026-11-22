using Microsoft.Net.Http.Headers;

sealed record Conditions(IList<EntityTagHeaderValue> Match, IList<EntityTagHeaderValue> NoneMatch)
{
    public static Conditions From(HttpRequest req) => new(Parse(req, "If-Match"), Parse(req, "If-None-Match"));

    private static IList<EntityTagHeaderValue> Parse(HttpRequest req, string name)
    {
        if (!req.Headers.TryGetValue(name, out var values)) return [];
        if (!EntityTagHeaderValue.TryParseStrictList([values.ToString()], out var tags)
            || tags.Count == 0 || (tags.Count > 1 && tags.Any(t => t.Equals(EntityTagHeaderValue.Any))))
            throw new BadHttpRequestException($"Malformed {name}.", 400);
        return tags;
    }

    // False means a conditional read can return 304 without a body.
    public bool Check(EntityTagHeaderValue tag, bool writing)
    {
        if (writing && (Match.Count == 0 || Match[0].Equals(EntityTagHeaderValue.Any)))
            throw new BadHttpRequestException("Read the note and submit its ETag in If-Match.", 428);
        if (Match.Count > 0 && !Match.Any(t => t.Equals(EntityTagHeaderValue.Any) || t.Compare(tag, true)))
            throw new BadHttpRequestException("Revision changed. Read the latest note before merging.", 412);
        if (!NoneMatch.Any(t => t.Equals(EntityTagHeaderValue.Any) || t.Compare(tag, false))) return true;
        if (writing) throw new BadHttpRequestException("If-None-Match precondition failed.", 412);
        return false;
    }
}
