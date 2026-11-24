using OverlapHours;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapPost("/availability/search", (SearchRequest request) =>
{
    try
    {
        return Results.Ok(Planner.Search(request));
    }
    catch (ArgumentException error)
    {
        return Results.BadRequest(new { error = error.Message });
    }
});

app.Run();
