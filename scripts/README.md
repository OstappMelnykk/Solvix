# Скрипти запуску

Повний гайд з поясненнями (Docker/Colima/docker-compose, архітектура, troubleshooting): [`docs/RUNNING.md`](../docs/RUNNING.md).

## dev/ — розробка (з hot-reload)

| Скрипт | Що робить |
|---|---|
| `dev/full/up.command` | Все одразу: Colima → postgres (Docker) → `Solvix.Api` (`dotnet run --launch-profile https`) → `solvix-web` (`ng serve`) |
| `dev/full/down.command` | Гасить `dotnet`/`ng serve`, зупиняє контейнер `postgres` |
| `dev/db/up.command` | Тільки Colima → postgres. Використовуй, якщо `Solvix.Api`/`solvix-web` запускаєш сам з IDE |
| `dev/db/down.command` | Зупиняє тільки контейнер `postgres` |

**Якщо запускаєш API/фронт з IDE:** `./dev/db/up.command`, потім у своїй run-конфігурації для `Solvix.Api` постав launch profile **`https`** (не `http`) — інакше фронтенд (`localhost:7153`) не достукається.

## docker/ — повна збірка (як на проді, без hot-reload)

| Скрипт | Що робить |
|---|---|
| `docker/up.command` | `docker compose up --build` — postgres + api + web, всі в контейнерах → http://localhost:8081 |
| `docker/down.command` | `docker compose down` — гасить і видаляє всі 3 контейнери |

## Colima

Усі скрипти, що чіпають Docker, самі перевіряють і за потреби піднімають Colima (`colima start`). Якщо не піднімається сама:
```
colima delete && colima start
```
