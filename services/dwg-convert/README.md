# dwg-convert

A ~500-line .NET 8 service that turns a DWG into an ASCII DXF and returns it. That is
all it does.

## Why it exists, and why it is this small

BIMCAD Studio's DXF pipeline (`src/cad/dxf/`) is the only thing in the product that
understands drawing semantics: OCS transforms, bulge arcs, hatch patterns, block
expansion, text justification. That code was earned against real files over a long
time and it is the single source of truth.

DWG is a different container for the same drawing. So this service **converts and
nothing else** — [ACadSharp](https://github.com/DomCR/ACadSharp)'s `DwgReader` in,
`DxfWriter` out — and hands the DXF text to the existing TypeScript parser untouched.
It deliberately does not normalise, simplify, flatten, or interpret anything. The
moment it starts doing that, there are two parsers in two languages and they begin to
drift.

If you are tempted to "fix a drawing" here: don't. Fix it in `src/cad/dxf/`, where the
fix also benefits every DXF that never went near this service.

---

## Run it

Either way works; you do not need both. **Docker needs no .NET installed.**

### Docker (recommended, no local SDK)

```bash
cd services/dwg-convert
docker compose up --build
```

Stop with `Ctrl+C`, or `docker compose down`. Rebuild after editing `Program.cs` with
`docker compose up --build` again.

Without compose:

```bash
cd services/dwg-convert
docker build -t bimcad/dwg-convert .
docker run --rm -p 5179:5179 \
  -e ALLOWED_ORIGINS=http://localhost:5173 \
  -e MAX_UPLOAD_MB=200 \
  bimcad/dwg-convert
```

### Local .NET SDK

Requires the [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
(`dotnet --version` should print `8.x` or newer).

```bash
cd services/dwg-convert
dotnet restore
dotnet run --configuration Release
```

Override configuration inline:

```bash
# bash / zsh
PORT=5179 ALLOWED_ORIGINS=http://localhost:5173 MAX_UPLOAD_MB=500 dotnet run -c Release

# PowerShell
$env:PORT=5179; $env:MAX_UPLOAD_MB=500; dotnet run -c Release
```

### Confirm it is up

```bash
curl http://localhost:5179/health
# {"ok":true,"acadsharp":"3.6.51","maxUploadMb":200,"timeoutSeconds":180}

curl -F "file=@some-drawing.dwg" http://localhost:5179/convert -o out.dxf
head -4 out.dxf     # should be:  0 / SECTION / 2 / HEADER
```

---

## Point the app at it

`VITE_DWG_SERVICE_URL` in the repo-root `.env` (already present in `.env.example`):

```
VITE_DWG_SERVICE_URL=http://localhost:5179
```

Vite inlines `VITE_*` at build time, so **restart `npm run dev` after changing it.**

- Unset → the client falls back to `http://localhost:5179`.
- Set to an empty value → DWG import is switched off entirely. DXF import is
  unaffected either way; the service being down can never break a DXF.

Client side lives in `src/io/dwg.ts`. `File ▸ Import DXF / DWG` in the toolbar and
`Import DXF / DWG` on the dashboard both route through it: a DXF is read as text
exactly as before, a DWG is health-checked, uploaded, converted, and the returned DXF
text goes into `importCadDrawing()` unchanged.

---

## API

### `GET /health`

```json
{ "ok": true, "acadsharp": "3.6.51", "maxUploadMb": 200, "timeoutSeconds": 180 }
```

Used by the client to decide whether DWG import is offered at all.

### `POST /convert`

`multipart/form-data` with a `file` field.

**200** — body is ASCII DXF, `Content-Type: text/plain; charset=utf-8`. Response
headers `X-Dwg-Version` (e.g. `AC1032`), `X-Convert-Ms`, `X-Dwg-Warnings` (count of
things ACadSharp could not read).

**Failure** — always JSON, never a bare status:

```json
{ "error": "DWG format 'AC1009' (AutoCAD R11/R12) cannot be read by this converter..." }
```

| Status | When |
| --- | --- |
| 400 | not multipart, no `file`, no DWG signature at offset 0, DWG version older than AC1014, truncated file |
| 413 | larger than `MAX_UPLOAD_MB` |
| 422 | corrupt DWG, DXF write failure, or converted-but-empty (the proxy-object case) |
| 500 | anything unexpected inside ACadSharp — still JSON, with the exception type and message |
| 504 | conversion exceeded `CONVERT_TIMEOUT_SECONDS` |

The client (`src/io/dwg.ts`) surfaces the `error` string verbatim in a toast, so these
messages are user-facing. Keep them written for a person, not a log.

### Version support

ACadSharp's `DwgReader` handles **AC1014 (R14) through AC1032 (2018+)**. AC1009
(R11/R12) and AC1012 (R13) are rejected at the signature check with a message naming
the release — no point uploading 80 MB to learn that.

---

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `5179` | |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated. `*` allows any origin. Add the production origin here. |
| `MAX_UPLOAD_MB` | `200` | Clamped to 1–1900; the upload is buffered in memory. |
| `CONVERT_TIMEOUT_SECONDS` | `180` | Clamped to 1–3600. |

### Memory

Both the DWG upload and the DXF output are held in memory, and DXF runs roughly 3–6×
the DWG's size. A 200 MB drawing can peak well past 1 GB. `docker-compose.yml` sets
`mem_limit: 2g`; raise it before raising `MAX_UPLOAD_MB`.

### ACadSharp version

Pinned to **3.6.51** in `DwgConvert.csproj`, not floated. That is the last release of
the mature 3.6 line, and the version whose source (git tag `v3.6.51`) every API call in
`Program.cs` was read against. 3.7.1 exists but was days old at the time of writing,
and ACadSharp's IO surface has moved between minor versions before (3.6.29 was
deprecated for critical bugs). To upgrade: bump the version, re-read
`src/ACadSharp/IO/DwgReader.cs` and `src/ACadSharp/IO/DxfWriter.cs` at the matching
tag, then re-run the round-trip check below.

---

## ⚠️ UNVERIFIED — read this before trusting anything above

**This service has never been compiled or run.** It was written on a machine with no
.NET SDK installed. Every claim about its behaviour is derived from reading ACadSharp's
source at tag `v3.6.51` and from the ASP.NET Core 8 API surface — not from observing it
work.

Specifically **unverified**:

1. **It compiles.** No `dotnet build` was ever executed. Expect to fix something on the
   first build.
2. **It converts a real DWG.** No DWG has been through it. The DXF it emits has never
   been seen, let alone fed to `src/cad/dxf/`.
3. **The round trip is faithful.** Whether ACadSharp's DWG→DXF preserves the things
   BIMCAD's parser depends on — OCS extrusion vectors, polyline bulges, hatch boundary
   paths, block base points, MTEXT formatting codes — is completely untested here.
   This is the single most important thing to check.
4. **Docker build works** and the base image tags resolve.
5. **Error mapping is right.** Which exception ACadSharp actually throws for a corrupt
   vs. an unsupported vs. a proxy-heavy DWG is an educated guess from its source. The
   catch clauses reference real, public exception types
   (`ACadSharp.Exceptions.CadNotSupportedException`, `DwgException`, `DxfException`),
   but which one fires for which real-world file is unconfirmed.
6. **The "no drawable geometry" 422** is a heuristic, not a fact. It fires when every
   block record in the converted document has zero entities. It is intended to catch
   proxy-heavy vertical-product drawings (Civil 3D, AEC/ADT, MEP). It could in
   principle reject a legitimate but unusual drawing.
7. **Legacy code-page transcoding.** Pre-AC1021 drawings are written by ACadSharp in
   the drawing's ANSI code page and are transcoded to UTF-8 here. The `ANSI_<cp>`
   parsing in `ResolveCodePage` reimplements ACadSharp's `CadUtils.GetCodePage`, which
   is `internal` and could not be called. ASCII-only drawings are unaffected; a
   pre-2007 drawing with non-Latin text is where this would show up.
8. **The conversion timeout does not kill the work.** ACadSharp is synchronous with no
   cancellation hook. On timeout the request returns 504 immediately but the conversion
   thread keeps running to completion in the background, holding its memory. A stream
   of timeouts will pile up. This is a known, deliberate limitation, not an oversight —
   see the comment in `Program.cs`.

### What was verified

- Every ACadSharp type, member and overload used was read in that library's source at
  tag `v3.6.51`: `DwgReader.Read(Stream, DwgReaderConfiguration, NotificationEventHandler)`,
  `new DxfWriter(Stream, CadDocument, bool)`, `writer.Configuration`, `writer.OnNotification`,
  `writer.Write()`, `NotificationEventArgs.Message` / `.NotificationType`,
  `CadDocument.Header.Version` / `.CodePage`, `CadDocument.ModelSpace` / `.BlockRecords`,
  `BlockRecord.Entities.Count`, and the `DwgReaderConfiguration` /
  `CadWriterConfiguration` property names.
- The version-support table came from ACadSharp's own README at the same tag.
- The TypeScript half (`src/io/dwg.ts` and the two import handlers) **is** verified —
  `npx tsc --noEmit` is clean.

### First-run checklist

```bash
cd services/dwg-convert
dotnet build                                    # 1. does it compile
docker compose up --build                       # 2. does it start
curl http://localhost:5179/health               # 3. does it answer
curl -F "file=@real-drawing.dwg" http://localhost:5179/convert -o out.dxf   # 4. does it convert
```

Then the one that actually matters: import `out.dxf` through the normal DXF path and
compare it against the same drawing exported to DXF from AutoCAD. Layer count, entity
count, hatches, and text placement are the tells.
