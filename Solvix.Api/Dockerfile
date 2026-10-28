FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

# Whole backend source (see .dockerignore for what is left out) - an explicit
# per-project list silently rots every time a project is added.
COPY . .
RUN dotnet restore Solvix.Api/Solvix.Api.csproj

RUN dotnet publish Solvix.Api/Solvix.Api.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app
COPY --from=build /app .

ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080

ENTRYPOINT ["dotnet", "Solvix.Api.dll"]