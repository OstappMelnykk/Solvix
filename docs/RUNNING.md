# Запуск Solvix

```
./scripts/solvix demo      # усе в Docker -> http://localhost:8081
./scripts/solvix up        # розробка з hot-reload -> http://localhost:4200
./scripts/solvix panel     # лише панель керування -> http://localhost:5200
./scripts/solvix status    # що працює
./scripts/solvix down      # вимкнути все
```

Те саме з меню: подвійний клік на `scripts/Solvix.command`. Повна довідка команд - [`scripts/README.md`](../scripts/README.md).

## Режими

| | `demo` | `up` |
|---|---|---|
| db | Docker | Docker |
| api | Docker | `dotnet run` (https://localhost:7153/swagger) |
| web | Docker (nginx, проксі `/api`, `/hubs`) | `ng serve` |
| Hot-reload | ні | так |
| Потрібно локально | лише Docker/Colima + .NET 8 для панелі | + Node 20+ |

Frontend у режимі `up` ходить на `https://localhost:7153` (`solvix-web/src/environments/environment.ts`), тому скрипт запускає API з https. Потрібен dev-сертифікат: `dotnet dev-certs https --trust`.

## Панель керування (`Solvix.Control`)

Окремий ASP.NET Core (Blazor Server) проєкт, який не залежить від інших проєктів Solvix. Показує:

- **Стан** усіх компонентів: db, API (кожен екземпляр окремо), frontend, web, сама панель - стан, порт, pid, аптайм, пам'ять/CPU/req/s.
- **Хто запустив**: Docker, `solvix` скрипт, IDE (Rider, VS Code, WebStorm…), термінал, інша машина. Для API це приходить від самого API (`SOLVIX_LAUNCHER`, якщо запущено нашим скриптом/Docker, інакше визначається за деревом батьківських процесів); для frontend - за деревом процесів.
- **Логи** API наживо з фільтрами (рівень, інстанс, пошук); зберігаються в `.solvix/logs/entries-*.jsonl`. Вивід `be`/`fe`/контейнерів - кнопка «вивід».
- **План запуску**: для бази, Backend і Frontend окремо обираєш спосіб - Docker, термінал (скрипт), IDE або вимкнено (є й швидкі пресети). Панель порівнює вибір із поточним станом і робить лише різницю: зупиняє, що працює інакше, і запускає, що треба. Для IDE вона не може натиснути Run сама - показує крок «Запусти Backend в IDE» і чекає, поки процес з'явиться. Правила: Backend у Docker доступний лише разом з Web у Docker (і навпаки); Backend потребує бази.
- **Старт/Стоп** для того, що запущено скриптом або Docker. Усе, що запущено з IDE, панель лише показує - зупиняється воно там, де запущено.

Як API потрапляє в панель: `Solvix.Api` при старті й кожні 5 с шле панелі свою реєстрацію (`POST /api/instances`), а логи пачками (`POST /api/logs`). Адреса - `Control:Url` (у Development `http://localhost:5200`, у Docker `host.docker.internal:5200`; порожня = вимкнено). Якщо панелі нема - API нічого не помічає. Кілька реплік за load balancer з'являться окремими рядками.

Машинний вигляд стану: `GET http://localhost:5200/api/stack`.

## Docker і Colima

Скрипти самі підіймають Colima, якщо Docker не відповідає. Якщо не стартує: `colima delete && colima start`. `solvix down --colima` зупиняє VM (з підтвердженням, якщо там є чужі контейнери).

## Діагностика

- `solvix doctor` - перевірка середовища і портів.
- `solvix logs be|fe|panel|db|api|web [-f]` - логи; `solvix logs` - журнал дій.
- Порт зайнятий чужим процесом - `status`/`doctor` покажуть, яким (pid), далі `kill <pid>`.
- Змінити порти бази/web - `DB_PORT`, `WEB_PORT` у `.env`.
- Дані бази живуть у docker volume; повне очищення - `solvix reset`.
