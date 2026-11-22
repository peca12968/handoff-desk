using Microsoft.Data.Sqlite;
using Microsoft.Net.Http.Headers;

sealed record Revision(Guid Id, long Number, string Token, byte[] Body)
{
    public EntityTagHeaderValue Tag => new($"\"{Token}\"");

    public static Revision New(Guid id, long number, byte[] body) => new(id, number, Guid.NewGuid().ToString("N"), body);
}

sealed class NoteStore(string path)
{
    private readonly string connectionString = new SqliteConnectionStringBuilder
    {
        DataSource = path, DefaultTimeout = 5
    }.ToString();

    private SqliteConnection Open()
    {
        var db = new SqliteConnection(connectionString);
        db.Open();
        return db;
    }

    public void Initialize()
    {
        using var db = Open();
        using var command = db.CreateCommand();
        command.CommandText = """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS revisions (
                note_id TEXT NOT NULL,
                version INTEGER NOT NULL CHECK (version >= 1),
                token TEXT NOT NULL,
                body BLOB NOT NULL,
                PRIMARY KEY (note_id, version)
            ) WITHOUT ROWID;
            """;
        command.ExecuteNonQuery();
    }

    private static void Append(SqliteConnection db, SqliteTransaction? tx, Revision note)
    {
        using var command = db.CreateCommand();
        command.Transaction = tx;
        command.CommandText = "INSERT INTO revisions(note_id, version, token, body) VALUES ($id, $version, $token, $body)";
        command.Parameters.AddWithValue("$id", note.Id.ToString("N"));
        command.Parameters.AddWithValue("$version", note.Number);
        command.Parameters.AddWithValue("$token", note.Token);
        command.Parameters.AddWithValue("$body", note.Body);
        command.ExecuteNonQuery();
    }

    public Revision Create(byte[] body)
    {
        using var db = Open();
        var note = Revision.New(Guid.NewGuid(), 1, body);
        Append(db, null, note);
        return note;
    }

    private static Revision Read(SqliteConnection db, SqliteTransaction? tx, Guid id, long? version)
    {
        using var command = db.CreateCommand();
        command.Transaction = tx;
        command.CommandText = version.HasValue
            ? "SELECT version, token, body FROM revisions WHERE note_id=$id AND version=$version"
            : "SELECT version, token, body FROM revisions WHERE note_id=$id ORDER BY version DESC LIMIT 1";
        command.Parameters.AddWithValue("$id", id.ToString("N"));
        if (version.HasValue) command.Parameters.AddWithValue("$version", version.Value);
        using var row = command.ExecuteReader();
        if (!row.Read()) throw new BadHttpRequestException("Note or revision not found.", 404);
        return new(id, row.GetInt64(0), row.GetString(1), (byte[])row[2]);
    }

    public Revision Get(Guid id, long? version = null)
    {
        using var db = Open();
        return Read(db, null, id, version);
    }

    public Revision Update(Guid id, byte[] body, Conditions conditions)
    {
        using var db = Open();
        // Obtain the SQLite writer lock before reading the version for comparison.
        using var tx = db.BeginTransaction(deferred: false);
        var current = Read(db, tx, id, null);
        conditions.Check(current.Tag, writing: true);
        if (!body.AsSpan().SequenceEqual(current.Body))
        {
            current = Revision.New(id, current.Number + 1, body);
            Append(db, tx, current);
        }
        tx.Commit();
        return current;
    }
}
