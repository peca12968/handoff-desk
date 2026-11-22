using System.Globalization;
using System.Text;
using System.Text.Json.Serialization;
using Microsoft.Data.Sqlite;
using Microsoft.Net.Http.Headers;

var app = WebApplication.CreateBuilder(args).Build();
var notes = new NoteStore(Environment.GetEnvironmentVariable("HANDOFF_DB") ?? "handoff.db");
notes.Initialize();

app.Use(async (ctx, next) =>
{
    try { await next(ctx); }
    catch (BadHttpRequestException error)
    {
        ctx.Response.Headers.CacheControl = "no-store";
        await Results.Problem(detail: error.Message, statusCode: error.StatusCode).ExecuteAsync(ctx);
    }
    catch (SqliteException error) when (error.SqliteErrorCode is 5 or 6)
    {
        ctx.Response.Headers.RetryAfter = "1";
        await Results.Problem(detail: "Database busy. Retry the conditional request.", statusCode: 503).ExecuteAsync(ctx);
    }
});

app.MapPost("/notes", async (HttpContext ctx) =>
{
    var created = notes.Create(await ReadBody(ctx.Request));
    SetVersion(ctx.Response, created);
    ctx.Response.Headers.Location = $"/notes/{created.Id:D}";
    return Results.StatusCode(201);
});
app.MapGet("/notes/{id:guid}", (Guid id, HttpContext ctx) => Fetch(ctx, notes.Get(id)));
app.MapGet("/notes/{id:guid}/revisions/{version:long:min(1)}",
    (Guid id, long version, HttpContext ctx) => Fetch(ctx, notes.Get(id, version)));
app.MapPut("/notes/{id:guid}", async (Guid id, HttpContext ctx) =>
{
    var conditions = Conditions.From(ctx.Request);
    var saved = notes.Update(id, await ReadBody(ctx.Request), conditions);
    SetVersion(ctx.Response, saved);
    return Results.NoContent();
});
app.MapPatch("/notes/{id:guid}", (Guid id, RestoreEdit edit, HttpContext ctx) =>
{
    if (edit.RestoreRevision < 1) throw new BadHttpRequestException("Expected a positive restoreRevision.", 400);
    var saved = notes.Restore(id, edit.RestoreRevision, Conditions.From(ctx.Request));
    SetVersion(ctx.Response, saved);
    return Results.NoContent();
});
app.Run();

static void SetVersion(HttpResponse response, Revision note)
{
    response.Headers.ETag = note.Tag.ToString();
    response.Headers["Handoff-Revision"] = note.Number.ToString(CultureInfo.InvariantCulture);
    response.Headers.CacheControl = "private, no-cache";
}

static IResult Fetch(HttpContext ctx, Revision note)
{
    bool modified = Conditions.From(ctx.Request).Check(note.Tag, writing: false);
    SetVersion(ctx.Response, note);
    return modified ? Results.Bytes(note.Body, "text/plain; charset=utf-8") : Results.StatusCode(304);
}

static async Task<byte[]> ReadBody(HttpRequest req)
{
    const int limit = 16 * 1024;
    if (!MediaTypeHeaderValue.TryParse(req.ContentType, out var media) ||
        !media.MediaType.Equals("text/plain", StringComparison.OrdinalIgnoreCase) ||
        (media.Charset.HasValue && !HeaderUtilities.RemoveQuotes(media.Charset).Equals("utf-8", StringComparison.OrdinalIgnoreCase)) ||
        req.Headers.ContainsKey("Content-Encoding"))
        throw new BadHttpRequestException("Send unencoded UTF-8 text/plain.", 415);
    if (req.ContentLength > limit) throw new BadHttpRequestException("Maximum note size is 16 KiB.", 413);
    using var body = new MemoryStream();
    var buffer = new byte[4096];
    int count;
    while ((count = await req.Body.ReadAsync(buffer, req.HttpContext.RequestAborted)) > 0)
    {
        if (body.Length + count > limit) throw new BadHttpRequestException("Maximum note size is 16 KiB.", 413);
        body.Write(buffer, 0, count);
    }
    var bytes = body.ToArray();
    if (bytes.Length == 0) throw new BadHttpRequestException("Empty note.", 400);
    try { _ = new UTF8Encoding(false, true).GetCharCount(bytes); }
    catch (DecoderFallbackException) { throw new BadHttpRequestException("Invalid UTF-8.", 400); }
    return bytes;
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
sealed record RestoreEdit([property: JsonNumberHandling(JsonNumberHandling.Strict)] long RestoreRevision);
