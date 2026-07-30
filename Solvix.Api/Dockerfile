FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

COPY NuGet.Config .
COPY Solvix.Api/Solvix.Api.csproj Solvix.Api/
COPY Solvix.Contracts/Solvix.Contracts.csproj Solvix.Contracts/
COPY Solvix.Solver/Solvix.Solver.csproj Solvix.Solver/
COPY Solvix.MeshBuilder/Solvix.MeshBuilder.csproj Solvix.MeshBuilder/
COPY Solvix.Bridge/Solvix.Bridge.csproj Solvix.Bridge/
COPY Solvix.Data/Solvix.Data.csproj Solvix.Data/
RUN dotnet restore Solvix.Api/Solvix.Api.csproj

COPY Solvix.Api/ Solvix.Api/
COPY Solvix.Contracts/ Solvix.Contracts/
COPY Solvix.Solver/ Solvix.Solver/
COPY Solvix.MeshBuilder/ Solvix.MeshBuilder/
COPY Solvix.Bridge/ Solvix.Bridge/
COPY Solvix.Data/ Solvix.Data/

RUN dotnet publish Solvix.Api/Solvix.Api.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app
COPY --from=build /app .

ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080

ENTRYPOINT ["dotnet", "Solvix.Api.dll"]