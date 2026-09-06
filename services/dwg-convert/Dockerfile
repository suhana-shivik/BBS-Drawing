# Multi-stage so nothing but the runtime ships, and so the service can be built
# and run on a machine with no .NET SDK installed.
#
#   docker compose up --build          (from services/dwg-convert)
#   docker build -t bimcad/dwg-convert .

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

# Restore against the project file alone first, so a source-only edit does not
# invalidate the NuGet layer.
COPY DwgConvert.csproj ./
RUN dotnet restore DwgConvert.csproj

COPY . ./
RUN dotnet publish DwgConvert.csproj \
      --configuration Release \
      --no-restore \
      --output /app/publish


FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app

COPY --from=build /app/publish ./

# The .NET 8 base image defaults ASPNETCORE_HTTP_PORTS to 8080. Clear it so the
# only thing deciding the port is PORT, which Program.cs reads.
ENV ASPNETCORE_HTTP_PORTS=
ENV ASPNETCORE_URLS=
ENV PORT=5179
ENV ALLOWED_ORIGINS=http://localhost:5173
ENV MAX_UPLOAD_MB=200
ENV CONVERT_TIMEOUT_SECONDS=180

# The whole upload plus the whole DXF are held in memory, so a container memory
# limit below roughly 8x MAX_UPLOAD_MB will OOM on large drawings.
EXPOSE 5179

USER app

ENTRYPOINT ["dotnet", "DwgConvert.dll"]
