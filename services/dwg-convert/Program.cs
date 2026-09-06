// BIMCAD Studio - DWG to DXF conversion service.
//
// Scope, deliberately narrow: this service CONVERTS and does nothing else. It
// reads a DWG with ACadSharp and writes the same drawing straight back out as
// ASCII DXF. Every piece of semantic interpretation - OCS transforms, bulge
// arcs, hatch patterns, block expansion, text justification - stays in the
// TypeScript parser under src/cad/dxf/, which is battle-tested against real
// files. Re-implementing any of it here would create a second copy in a second
// language that drifts from the first the moment either is touched.
//
// Configuration, all optional, all environment variables:
//   PORT                     listen port                          default 5179
//   ALLOWED_ORIGINS          comma-separated CORS origins, or "*" default http://localhost:5173
//   MAX_UPLOAD_MB            reject uploads larger than this      default 200
//   CONVERT_TIMEOUT_SECONDS  give up on a single conversion       default 180
//
// Endpoints:
//   GET  /health   -> {"ok":true,"acadsharp":"<version>",...}
//   POST /convert  -> multipart/form-data with a `file` field, returns DXF text
//
// Failures always come back as 4xx/5xx with a JSON {"error":"..."} body naming
// what went wrong, never a bare status code.

using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using ACadSharp;
using ACadSharp.Exceptions;
using ACadSharp.IO;
using Microsoft.AspNetCore.Http.Features;

// ---------------------------------------------------------------- configuration

int port = EnvInt("PORT", 5179, 1, 65535);

// The whole upload is buffered in a MemoryStream, so the ceiling is bounded by
// int.MaxValue however generous MAX_UPLOAD_MB is set.
int maxUploadMb = EnvInt("MAX_UPLOAD_MB", 200, 1, 1900);
long maxUploadBytes = (long)maxUploadMb * 1024L * 1024L;

int timeoutSeconds = EnvInt("CONVERT_TIMEOUT_SECONDS", 180, 1, 3600);

string[] allowedOrigins = (Environment.GetEnvironmentVariable("ALLOWED_ORIGINS") ?? "http://localhost:5173")
    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

// Needed by Encoding.GetEncoding(<ansi code page>) below. Registering twice is
// harmless; ACadSharp registers it internally as well.
try
{
    Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
}
catch
{
    // Provider unavailable - ResolveCodePage falls back to Latin1.
}

UTF8Encoding utf8NoBom = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

// DWG signature at offset 0 is six ASCII bytes. ACadSharp's DwgReader supports
// AC1014 and up (see the compatibility table in its README); the older codes are
// listed only so the rejection message can name the release.
HashSet<string> readableDwg = new HashSet<string>(StringComparer.Ordinal)
{
    "AC1014", "AC1015", "AC1018", "AC1021", "AC1024", "AC1027", "AC1032",
};
Dictionary<string, string> dwgReleases = new Dictionary<string, string>(StringComparer.Ordinal)
{
    ["AC1032"] = "AutoCAD 2018-2026",
    ["AC1027"] = "AutoCAD 2013-2017",
    ["AC1024"] = "AutoCAD 2010-2012",
    ["AC1021"] = "AutoCAD 2007-2009",
    ["AC1018"] = "AutoCAD 2004-2006",
    ["AC1015"] = "AutoCAD 2000-2002",
    ["AC1014"] = "AutoCAD R14",
    ["AC1012"] = "AutoCAD R13",
    ["AC1009"] = "AutoCAD R11/R12",
    ["AC1006"] = "AutoCAD R10",
    ["AC1004"] = "AutoCAD R9",
    ["AC1003"] = "AutoCAD 2.60",
    ["AC1002"] = "AutoCAD 2.50",
};

string acadSharpVersion = ResolveAcadSharpVersion();

// ---------------------------------------------------------------- host

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
builder.WebHost.ConfigureKestrel(kestrel =>
{
    kestrel.Limits.MaxRequestBodySize = maxUploadBytes;
    // A 200 MB upload from a laptop on hotel wifi must not be shot down for
    // being slow; the conversion timeout is the real guard.
    kestrel.Limits.MinRequestBodyDataRate = null;
    kestrel.Limits.KeepAliveTimeout = TimeSpan.FromSeconds(timeoutSeconds + 60);
});

builder.Services.Configure<FormOptions>(options =>
{
    options.MultipartBodyLengthLimit = maxUploadBytes;
});

builder.Services.AddCors(options => options.AddDefaultPolicy(policy =>
{
    if (allowedOrigins.Length == 1 && allowedOrigins[0] == "*")
    {
        policy.AllowAnyOrigin();
    }
    else
    {
        policy.WithOrigins(allowedOrigins);
    }

    policy.AllowAnyHeader()
          .AllowAnyMethod()
          .WithExposedHeaders("X-Dwg-Version", "X-Convert-Ms", "X-Dwg-Warnings");
}));

var app = builder.Build();
app.UseCors();

var startupLog = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("dwg-convert");
startupLog.LogInformation(
    "dwg-convert listening on {Port} acadsharp={AcadSharp} maxUploadMb={MaxUploadMb} timeoutSeconds={TimeoutSeconds} origins={Origins}",
    port, acadSharpVersion, maxUploadMb, timeoutSeconds, string.Join(", ", allowedOrigins));

// ---------------------------------------------------------------- /health

app.MapGet("/health", () => Results.Json(new
{
    ok = true,
    acadsharp = acadSharpVersion,
    maxUploadMb,
    timeoutSeconds,
}));

// ---------------------------------------------------------------- /convert

app.MapPost("/convert", async (HttpRequest request, ILoggerFactory loggerFactory, CancellationToken clientToken) =>
{
    var log = loggerFactory.CreateLogger("convert");
    var stopwatch = Stopwatch.StartNew();

    if (!request.HasFormContentType)
    {
        return Fail(StatusCodes.Status400BadRequest,
            "Send the drawing as multipart/form-data with a `file` field.");
    }

    IFormFile? file;
    try
    {
        var form = await request.ReadFormAsync(clientToken);
        file = form.Files["file"] ?? form.Files.FirstOrDefault();
    }
    catch (InvalidDataException)
    {
        // FormOptions.MultipartBodyLengthLimit exceeded.
        return Fail(StatusCodes.Status413PayloadTooLarge,
            $"Upload is larger than the {maxUploadMb} MB limit. Raise MAX_UPLOAD_MB on the conversion service if this drawing is genuinely that big.");
    }
    catch (BadHttpRequestException ex) when (ex.StatusCode == StatusCodes.Status413PayloadTooLarge)
    {
        // Kestrel MaxRequestBodySize exceeded.
        return Fail(StatusCodes.Status413PayloadTooLarge,
            $"Upload is larger than the {maxUploadMb} MB limit. Raise MAX_UPLOAD_MB on the conversion service if this drawing is genuinely that big.");
    }
    catch (BadHttpRequestException ex)
    {
        return Fail(StatusCodes.Status400BadRequest, $"Malformed upload: {ex.Message}");
    }

    if (file is null || file.Length == 0)
    {
        return Fail(StatusCodes.Status400BadRequest,
            "No file was uploaded. Attach the DWG as the `file` field of the form.");
    }

    string name = SafeName(file.FileName);

    if (file.Length > maxUploadBytes)
    {
        return Fail(StatusCodes.Status413PayloadTooLarge,
            $"'{name}' is {file.Length / (1024 * 1024)} MB, over the {maxUploadMb} MB limit.");
    }

    // ACadSharp needs a seekable stream, and the request body is not seekable.
    var input = new MemoryStream(capacity: (int)file.Length);
    try
    {
        await using var source = file.OpenReadStream();
        await source.CopyToAsync(input, clientToken);
    }
    catch (OperationCanceledException)
    {
        return Results.Empty;
    }

    input.Position = 0;

    string signature = ReadSignature(input);

    if (!signature.StartsWith("AC", StringComparison.Ordinal))
    {
        string looksLikeDxf = signature.TrimStart().StartsWith("0", StringComparison.Ordinal)
            ? " It looks like a DXF - import DXF files directly, they do not go through this service."
            : string.Empty;
        return Fail(StatusCodes.Status400BadRequest,
            $"'{name}' is not a DWG file: expected an AutoCAD signature at offset 0, found '{Printable(signature)}'.{looksLikeDxf}");
    }

    if (!readableDwg.Contains(signature))
    {
        string release = dwgReleases.TryGetValue(signature, out var r) ? $" ({r})" : string.Empty;
        return Fail(StatusCodes.Status400BadRequest,
            $"DWG format '{signature}'{release} cannot be read by this converter. ACadSharp reads AC1014 (R14) through AC1032 (2018+). Open the drawing in AutoCAD and save it as a newer DWG, or export a DXF.");
    }

    // ACadSharp is synchronous and offers no cancellation hook, so the timeout
    // is enforced by racing the work against a timer. HONEST CAVEAT: when the
    // timer wins, the conversion thread keeps running to completion in the
    // background - it cannot be killed. The request returns 504 immediately;
    // the CPU and memory are reclaimed whenever ACadSharp finishes or throws.
    var notices = new List<Notice>();
    var work = Task.Run(() => ConvertDwg(input, notices), CancellationToken.None);

    using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(timeoutSeconds));
    using var raceCts = CancellationTokenSource.CreateLinkedTokenSource(clientToken, timeoutCts.Token);
    var timer = Task.Delay(Timeout.Infinite, raceCts.Token);

    var finished = await Task.WhenAny(work, timer);
    if (finished != work)
    {
        if (clientToken.IsCancellationRequested)
        {
            log.LogInformation("convert aborted by client name={Name} bytesIn={BytesIn} ms={Ms}",
                name, file.Length, stopwatch.ElapsedMilliseconds);
            return Results.Empty;
        }

        log.LogWarning("convert timeout name={Name} bytesIn={BytesIn} ms={Ms} acadsharp={AcadSharp}",
            name, file.Length, stopwatch.ElapsedMilliseconds, acadSharpVersion);

        // Observe whatever the abandoned conversion eventually does, so it is
        // logged rather than surfacing later as an unobserved task exception.
        _ = work.ContinueWith(
            t => log.LogWarning(t.Exception, "abandoned conversion finished name={Name} faulted={Faulted}", name, t.IsFaulted),
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);

        return Fail(StatusCodes.Status504GatewayTimeout,
            $"Converting '{name}' took longer than {timeoutSeconds}s and was abandoned. Very large or proxy-heavy drawings can exceed this; raise CONVERT_TIMEOUT_SECONDS on the conversion service.");
    }

    Conversion conversion;
    try
    {
        conversion = await work;
    }
    catch (CadNotSupportedException ex)
    {
        log.LogWarning(ex, "convert unsupported name={Name}", name);
        return Fail(StatusCodes.Status400BadRequest,
            $"'{name}' uses a DWG version ACadSharp does not support: {ex.Message}");
    }
    catch (DwgException ex)
    {
        log.LogWarning(ex, "convert dwg-read-failed name={Name}", name);
        return Fail(StatusCodes.Status422UnprocessableEntity,
            $"'{name}' could not be read - the DWG appears corrupt or uses structures ACadSharp does not handle: {ex.Message}");
    }
    catch (DxfException ex)
    {
        log.LogWarning(ex, "convert dxf-write-failed name={Name}", name);
        return Fail(StatusCodes.Status422UnprocessableEntity,
            $"'{name}' was read but could not be written back out as DXF: {ex.Message}");
    }
    catch (EndOfStreamException ex)
    {
        log.LogWarning(ex, "convert truncated name={Name}", name);
        return Fail(StatusCodes.Status400BadRequest,
            $"'{name}' is truncated - the DWG ends before its data does. Re-copy or re-download the file.");
    }
    catch (NotSupportedException ex)
    {
        log.LogWarning(ex, "convert not-supported name={Name}", name);
        return Fail(StatusCodes.Status422UnprocessableEntity,
            $"'{name}' contains something ACadSharp cannot handle: {ex.Message}");
    }
    catch (Exception ex)
    {
        log.LogError(ex, "convert failed name={Name} bytesIn={BytesIn}", name, file.Length);
        return Fail(StatusCodes.Status500InternalServerError,
            $"Converting '{name}' failed inside ACadSharp {acadSharpVersion}: {ex.GetType().Name}: {ex.Message}");
    }

    stopwatch.Stop();

    // NotImplemented / NotSupported notices are ACadSharp telling us it walked
    // past something it could not decode. They are the single most useful
    // signal for diagnosing a drawing that imports thin, so they are always
    // logged even when the conversion succeeded.
    var unreadable = conversion.Notices
        .Where(n => n.Type is NotificationType.NotImplemented or NotificationType.NotSupported)
        .Select(n => n.Message)
        .Distinct(StringComparer.Ordinal)
        .Take(25)
        .ToList();

    var errors = conversion.Notices
        .Where(n => n.Type == NotificationType.Error)
        .Select(n => n.Message)
        .Distinct(StringComparer.Ordinal)
        .Take(10)
        .ToList();

    log.LogInformation(
        "convert name={Name} dwgVersion={DwgVersion} bytesIn={BytesIn} bytesOut={BytesOut} modelEntities={ModelEntities} totalEntities={TotalEntities} ms={Ms} acadsharp={AcadSharp} unreadable={Unreadable} errors={Errors}",
        name,
        conversion.Version,
        file.Length,
        conversion.Dxf.LongLength,
        conversion.ModelEntities,
        conversion.TotalEntities,
        stopwatch.ElapsedMilliseconds,
        acadSharpVersion,
        unreadable.Count == 0 ? "none" : string.Join(" | ", unreadable),
        errors.Count == 0 ? "none" : string.Join(" | ", errors));

    if (conversion.TotalEntities == 0)
    {
        string detail = unreadable.Count > 0
            ? $" ACadSharp could not read: {string.Join("; ", unreadable.Take(6))}."
            : string.Empty;
        return Fail(StatusCodes.Status422UnprocessableEntity,
            $"'{name}' converted but contains no drawable geometry.{detail} Drawings built from proxy or custom objects (Civil 3D, AEC/ADT, MEP verticals) store their geometry in a form only the matching AutoCAD vertical can expand. Open it in AutoCAD, EXPLODE the proxies or set PROXYGRAPHICS, and export a DXF instead.");
    }

    var response = request.HttpContext.Response;
    response.Headers["X-Dwg-Version"] = conversion.Version;
    response.Headers["X-Convert-Ms"] = stopwatch.ElapsedMilliseconds.ToString();
    response.Headers["X-Dwg-Warnings"] = unreadable.Count.ToString();

    // Always UTF-8 by the time it leaves here - see Convert(). text/plain keeps
    // `await response.text()` on the client trivially correct.
    return Results.Bytes(conversion.Dxf, "text/plain; charset=utf-8");
});

app.Run();

// ---------------------------------------------------------------- helpers

// The whole DWG-in / DXF-out step. Runs on a thread-pool thread; everything it
// touches is local to the call.
// ACadSharp 3.6.51 crashes writing a LEADER whose last segment has zero length:
// Leader.HasHookline calls AngleBetweenVectors, which throws on a zero vector.
// Real drawings contain such leaders (an annotation dragged onto its own anchor),
// and the reader accepts them happily — only the writer falls over. Rather than
// lose the whole drawing to one bad annotation, probe each leader with the exact
// property that crashes and drop only those that fail.
static int PruneUnwritableLeaders(CadDocument document, List<Notice> notices)
{
    int removed = 0;
    foreach (var blockRecord in document.BlockRecords)
    {
        List<ACadSharp.Entities.Entity> doomed = new();
        foreach (var entity in blockRecord.Entities)
        {
            if (entity is not ACadSharp.Entities.Leader leader) continue;
            try
            {
                // the exact call the DXF writer makes
                _ = leader.HasHookline;
            }
            catch (Exception)
            {
                doomed.Add(entity);
            }
        }

        foreach (var entity in doomed)
        {
            try
            {
                blockRecord.Entities.Remove(entity);
                removed++;
            }
            catch (Exception)
            {
                // if it cannot be removed the write will still fail, but the
                // notice below tells the user which drawing and how many
            }
        }
    }

    if (removed > 0)
    {
        notices.Add(new Notice(
            NotificationType.Warning,
            $"Dropped {removed} malformed LEADER annotation(s) that ACadSharp cannot write to DXF (zero-length leader segment). All other geometry is unaffected."));
    }

    return removed;
}

Conversion ConvertDwg(MemoryStream dwg, List<Notice> notices)
{
    void OnNotify(object? sender, NotificationEventArgs e) => notices.Add(new Notice(e.NotificationType, e.Message));

    // Read the input size NOW. DwgReader.Read() takes ownership of the stream
    // and disposes it, so asking for dwg.Length after the read throws
    // ObjectDisposedException — which is exactly what it did on the first real
    // DWG put through this service.
    long inputLength = dwg.Length;

    var readerConfiguration = new DwgReaderConfiguration
    {
        // Salvage what is readable rather than losing a 40 MB drawing to one
        // bad object. The notices record what was skipped.
        Failsafe = true,

        // Unknown/proxy objects carry no geometry and are dropped by the writer
        // anyway - keeping them only costs time and memory. The notices still
        // report them, which is what the "no geometry" diagnosis below needs.
        KeepUnknownEntities = false,
        KeepUnknownNonGraphicalObjects = false,

        // CRC verification roughly doubles read time and we are not archiving
        // the file, only converting it.
        CrcCheck = false,

        IgnoreProxyGraphics = true,
    };

    CadDocument document = DwgReader.Read(dwg, readerConfiguration, OnNotify);

    PruneUnwritableLeaders(document, notices);

    int modelEntities = CountEntities(() => document.ModelSpace);

    // Every block record, not just model space: extra paper-space layouts and
    // block definitions all count as "this drawing contains geometry". Getting
    // this wrong in the other direction would reject a perfectly good import.
    int totalEntities = 0;
    try
    {
        foreach (var blockRecord in document.BlockRecords)
        {
            totalEntities += blockRecord.Entities.Count;
        }
    }
    catch
    {
        // Diagnostic only - never let a table oddity sink the conversion.
    }

    string version = document.Header.Version.ToString();

    // DXF is roughly 3-6x the DWG on disk; pre-sizing avoids a chain of
    // doubling reallocations on large drawings.
    var output = new MemoryStream(capacity: (int)Math.Min(inputLength * 4L + 65536L, 64L * 1024 * 1024));

    // binary: false - the TypeScript parser in src/cad/dxf/ reads ASCII DXF.
    var writer = new DxfWriter(output, document, binary: false);
    writer.Configuration.CloseStream = false;

    // Badly formed DXF classes copied out of a DWG are a known source of files
    // that other applications then refuse; rebuilding them is cheap insurance.
    writer.Configuration.ResetDxfClasses = true;

    writer.OnNotification += OnNotify;

    // Deliberately not wrapped in try/finally: if Write throws we want that
    // exception, not whatever Dispose throws on a half-built writer. `output`
    // is a MemoryStream, so there is nothing to leak.
    writer.Write();
    writer.Dispose();

    byte[] bytes = output.ToArray();

    // ACadSharp's DxfWriter picks its encoding from the document version:
    // UTF-8 for AC1021 and later, the drawing's ANSI code page before that
    // (DxfWriter.createStreamWriter). fetch's Response.text() always decodes
    // UTF-8 regardless of the Content-Type charset, so transcode here rather
    // than push the problem onto the browser.
    if (document.Header.Version < ACadVersion.AC1021)
    {
        Encoding written = ResolveCodePage(document.Header.CodePage);
        if (written.CodePage != Encoding.UTF8.CodePage)
        {
            bytes = Encoding.Convert(written, utf8NoBom, bytes);
        }
    }

    return new Conversion(bytes, version, modelEntities, totalEntities, notices);
}

// Mirrors ACadSharp's writer-side encoding choice. Its own lookup table
// (CadUtils.GetCodePage) is `internal`, so parse the conventional "ANSI_<cp>"
// header value and fall back the way the library does, to Windows-1252.
Encoding ResolveCodePage(string? codePageName)
{
    if (!string.IsNullOrWhiteSpace(codePageName))
    {
        Match match = Regex.Match(codePageName, @"^ANSI_(\d{3,5})$", RegexOptions.IgnoreCase);
        if (match.Success && int.TryParse(match.Groups[1].Value, out int codePage))
        {
            try
            {
                return Encoding.GetEncoding(codePage);
            }
            catch
            {
                // Unknown code page - fall through to the default.
            }
        }
    }

    try
    {
        return Encoding.GetEncoding(1252);
    }
    catch
    {
        return Encoding.Latin1;
    }
}

// CadDocument.ModelSpace / .PaperSpace look the block record up by name and
// throw if a malformed DWG left it out. An entity count is diagnostic only, so
// a missing block space must not sink an otherwise good conversion.
static int CountEntities(Func<ACadSharp.Tables.BlockRecord> space)
{
    try
    {
        return space().Entities.Count;
    }
    catch
    {
        return 0;
    }
}

static IResult Fail(int status, string message) => Results.Json(new { error = message }, statusCode: status);

static int EnvInt(string key, int fallback, int min, int max)
{
    string? raw = Environment.GetEnvironmentVariable(key);
    if (!string.IsNullOrWhiteSpace(raw) && int.TryParse(raw, out int value))
    {
        return Math.Clamp(value, min, max);
    }

    return fallback;
}

static string ResolveAcadSharpVersion()
{
    Assembly assembly = typeof(CadDocument).Assembly;

    string? informational = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
    if (!string.IsNullOrWhiteSpace(informational))
    {
        // Strip the "+<git sha>" build metadata SourceLink appends.
        int plus = informational.IndexOf('+');
        return plus > 0 ? informational[..plus] : informational;
    }

    return assembly.GetName().Version?.ToString() ?? "unknown";
}

// Six ASCII bytes at offset 0, e.g. "AC1032". Leaves the stream rewound.
static string ReadSignature(Stream stream)
{
    Span<byte> head = stackalloc byte[6];
    stream.Position = 0;
    int read = stream.Read(head);
    stream.Position = 0;
    return read < head.Length ? string.Empty : Encoding.ASCII.GetString(head);
}

static string Printable(string value)
{
    if (value.Length == 0)
    {
        return "<fewer than 6 bytes>";
    }

    var sb = new StringBuilder(value.Length);
    foreach (char c in value)
    {
        sb.Append(c >= ' ' && c <= '~' ? c : '?');
    }

    return sb.ToString();
}

// Browsers send the bare file name, but never trust it for logging.
static string SafeName(string? fileName)
{
    string name = Path.GetFileName(fileName ?? string.Empty);
    return string.IsNullOrWhiteSpace(name) ? "unnamed.dwg" : Printable(name);
}

// ---------------------------------------------------------------- records

record Notice(NotificationType Type, string Message);

record Conversion(byte[] Dxf, string Version, int ModelEntities, int TotalEntities, List<Notice> Notices);
