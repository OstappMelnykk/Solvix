# Запуск Solvix — повний гайд

## TL;DR

```
./scripts/dev/full/up.command
```

Це піднімає **все**: базу даних, бекенд, фронтенд. Далі в документі — що саме це робить і чому.

---

## 1. З чого складається проєкт

Три окремі процеси, які мають працювати одночасно:

| Компонент | Що це | Де живе | На чому працює |
|---|---|---|---|
| **DB** (`postgres`) | База даних PostgreSQL 16 | В Docker-контейнері | Docker (через Colima) |
| **API** (`Solvix.Api`) | Бекенд на .NET 8 | Прямо на макбуці (`dotnet run`) | .NET SDK, встановлений локально |
| **Web** (`solvix-web`) | Фронтенд на Angular 18 | Прямо на макбуці (`ng serve`) | Node.js, встановлений локально |

API під'єднується до бази за адресою `localhost:5432` (див. `Solvix.Api/appsettings.Development.json`). Тобто: **поки postgres не підняли — `dotnet run` стартує, але будь-який запит, що чіпає базу, впаде**, бо конекшн-стрінг вказує на порт, де нічого не слухає.

Frontend (Angular) звертається до API на `https://localhost:7153` (див. `solvix-web/src/environments/environment.ts`) — тому `dotnet run` обов'язково має бути з профілем `https` (`dotnet run --launch-profile https`), інакше API підніметься тільки на http-порту, а фронт стукатиметься в порожнечу (`ERR_CONNECTION_REFUSED`).

**Отже порядок залежностей:**

```
postgres (Docker) → має бути healthy
        ↓
Solvix.Api (dotnet run --launch-profile https) → читає connection string, підключається до postgres
        ↓
solvix-web (ng serve) → ходить в API по /api/...
```

Скрипт `scripts/dev/full/up.command` саме в цьому порядку все й запускає.

---

## 2. До чого тут Docker / Colima / docker-compose — три різні речі

Це найплутаніша частина, тому детально:

### Docker (сам движок контейнерів)
Docker вміє запускати "контейнери" — ізольовані міні-системи з готовим софтом всередині (наприклад, повністю налаштований PostgreSQL). Замість того, щоб ставити Postgres на macOS напряму, ми просто кажемо "запусти образ `postgres:16-alpine`" — і воно працює однаково у будь-кого.

### Colima (де Docker фізично виконується на macOS)
Docker сам по собі — це Linux-технологія (контейнери = ізольовані Linux-процеси). macOS — не Linux, тому Docker на Mac завжди насправді працює **всередині легкої Linux-віртуалки**. На Windows/Mac для цього зазвичай ставлять **Docker Desktop** — але в цьому проєкті замість нього стоїть **Colima**: безкоштовна легка альтернатива, яка піднімає ту саму Linux-віртуалку і в ній ганяє Docker daemon.

Тобто: **Colima ≠ Docker**. Colima — це "двигун", на якому Docker працює. Команда `docker ...` (build/run/ps/compose) — це те, що ти пишеш; а щоб вона взагалі спрацювала, десь позаду має крутитись Colima-віртуалка.

- `colima start` — піднімає віртуалку (займає ~5-10 сек)
- `colima status` — чи вона зараз працює
- `colima stop` — вимикає її (звільняє RAM/CPU, які вона тримає)

**Саме "проблема з Colima", яку ти згадував раніше — це коли віртуалка просто не була запущена** (`colima status` → `Stopped`), тому будь-яка `docker`-команда падала з `connect: no such file or directory` (немає навіть сокета, куди стукатись). `scripts/dev/full/up.command` тепер сам це перевіряє і піднімає Colima автоматично, якщо треба (див. розділ "Troubleshooting").

### docker-compose (опис "яких контейнерів скільки і як підняти")
Один `docker run` — це один контейнер. У нас їх декілька (postgres, і в другому режимі запуску — ще й api та web), і в них є залежності одне від одного (наприклад, `api` не повинен стартувати, поки `postgres` не готовий). `docker-compose.yml` у корені репо — це файл, що описує всі ці контейнери разом, їхні порти, змінні середовища, залежності. Команда `docker compose up` читає цей файл і піднімає все, що там описано, в правильному порядку.

**У нашому `docker-compose.yml` описано 3 сервіси:**

```
services:
  postgres:  # база даних, порт 5432
  api:       # .NET бекенд, збирається з Solvix.Api/Dockerfile
  web:       # Angular через Nginx, збирається з solvix-web/Dockerfile, порт 8081
```

Але ми **не завжди** піднімаємо всі 3 — див. наступний розділ.

---

## 3. Два режими запуску — і чому їх два

### Режим A — Dev mode (`scripts/dev/full/up.command`) — рекомендований для розробки

```
./scripts/dev/full/up.command
```

Що відбувається покроково:
1. Копіює `.env.example` → `.env`, якщо `.env` ще нема (там пароль до бази).
2. Перевіряє, чи запущена Colima; якщо ні — `colima start`.
3. `docker compose up -d postgres` — **з усього docker-compose.yml піднімає ТІЛЬКИ postgres**, і чекає, поки він стане `healthy`.
4. `dotnet run --launch-profile https` у `Solvix.Api/` — запускає бекенд напряму на macOS (НЕ в контейнері).
5. `npm start` (= `ng serve`) у `solvix-web/` — запускає фронтенд напряму на macOS (НЕ в контейнері).

**Навіщо саме так:** і `dotnet run`, і `ng serve` мають hot-reload — зберіг файл, і зміна одразу підхопилась, без перезбірки Docker-образу. Це набагато швидше для розробки. Docker тут потрібен лише для бази, бо ставити й адмініструвати Postgres напряму на macOS незручно.

URL:
- Фронтенд: http://localhost:4200
- API/Swagger: https://localhost:7153/swagger (або http://localhost:5168/swagger)

Зупинка:
```
./scripts/dev/full/down.command
```
Вбиває процеси `dotnet`/`ng serve` і зупиняє контейнер `postgres` (саму Colima НЕ вимикає — раптом там ще щось крутиться).

### Режим B — Full Docker mode (`scripts/docker/up.command`) — "як у проді"

```
./scripts/docker/up.command
```

Це просто `docker compose up --build` — піднімає **всі 3** сервіси з `docker-compose.yml` як контейнери: postgres, api (збудований з `Solvix.Api/Dockerfile`) і web (Angular, зібраний і відданий через Nginx, `solvix-web/Dockerfile`).

**Навіщо цей режим:** перевірити, що весь стек реально збирається і працює так, як буде на сервері — без "у мене на компі працює". Мінус — немає hot-reload, кожна зміна коду вимагає `--build` заново (довше).

URL:
- Застосунок: http://localhost:8081 (Nginx сам проксіює `/api/` до контейнера `api`)

Зупинка:
```
./scripts/docker/down.command
```
Це `docker compose down` — гасить і видаляє всі 3 контейнери.

### Режим C — тільки БД (`scripts/dev/db/up.command`) — коли API/фронтенд запускаєш з IDE

```
./scripts/dev/db/up.command
```

Робить рівно перші 3 кроки режиму A (перевірка/старт Colima → `docker compose up -d postgres` → чекає `healthy`) і зупиняється — **не** чіпає `dotnet run`/`ng serve`. Використовуй, коли `Solvix.Api` і `solvix-web` запускаєш сам через IDE (Rider/VS Code run-конфігурації) замість терміналу — тоді треба лише підняти базу перед тим, як тиснути "Run" в IDE.

Не забудь у самій IDE-конфігурації `Solvix.Api` вказати launch profile **`https`** (не `http`) — інакше фронтенд (`localhost:7153`) не достукається (див. розділ 1 вище).

Зупинка:
```
./scripts/dev/db/down.command
```
Просто `docker compose stop postgres` — Colima й API/фронт (запущені з IDE) не чіпає, їх зупиняєш там само, де й запускав.

### Коли який використовувати
- Пишеш/дебажиш код щодня, запускаєш все з терміналу → **режим A** (dev).
- Пишеш/дебажиш код, а API/фронтенд запускаєш/дебажиш з IDE → **режим C** (тільки БД).
- Хочеш перевірити фінальну збірку перед комітом/релізом → **режим B** (docker).

---

## 4. Порти — шпаргалка

| Порт | Хто слухає | Коли |
|---|---|---|
| 4200 | Angular dev server (`ng serve`) | режим A |
| 5168 | Solvix.Api, http | режим A |
| 7153 | Solvix.Api, https (той, якого чекає фронтенд) | режим A |
| 5432 | Postgres | обидва режими |
| 8081 | Nginx (роздає Angular-білд + проксі на api) | режим B |
| — | Solvix.Api всередині контейнера слухає 8080, назовні не виведений | режим B |

---

## 5. Troubleshooting

**`colima is not running` / `docker ps` падає з `connect: no such file or directory`**
```
colima start
```
Якщо і це не піднімається:
```
colima delete && colima start   # перестворити віртуалку з нуля
colima start --edit             # подивитись/змінити виділені cpu/memory/disk
```
`scripts/dev/full/up.command` сам робить цю перевірку і сам виконує `colima start`.

**`Port 4200/5168/7153 is already in use`**
Значить попередній запуск (свій же) досі висить у фоні. Знайти й вбити:
```
lsof -ti:4200,5168,7153 | xargs kill
```

**Фронтенд кричить `ERR_CONNECTION_REFUSED` на `/api/...`**
API запущений не з тим профілем (без https) — фронтенд б'ється в 7153, а там нікого. Перевір, що `Solvix.Api` запущений саме командою `dotnet run --launch-profile https` (так робить `scripts/dev/full/up.command`), а не голим `dotnet run`.

**`.env` відсутній**
Обидва скрипти самі копіюють `.env.example` → `.env` при першому запуску. Пароль до бази лежить там (`POSTGRES_PASSWORD`).

**Хочу зупинити взагалі все, що стосується проєкту**
```
./scripts/dev/full/down.command
```
(вбиває dotnet/ng serve, гасить контейнер postgres; Colima і будь-які ІНШІ контейнери, які не стосуються Solvix, лишає працювати).
