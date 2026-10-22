# Запуск Solvix

```
./scripts/solvix up          # dev: спільна база + backend + frontend (hot-reload) -> http://localhost:4200
./scripts/solvix stack new   # новий ізольований Docker-інстанс -> http://localhost:808N
./scripts/solvix panel       # панель керування -> http://localhost:5200
./scripts/solvix status      # що працює
./scripts/solvix down        # вимкнути все
```

Те саме з меню: подвійний клік на `scripts/Solvix.command`. Повна довідка команд - [`scripts/README.md`](../scripts/README.md).

## Ізоляція: що з чим ділить базу

| Спосіб | База | Порти |
|---|---|---|
| IDE (Rider/WebStorm) і термінал (скрипт) | одна спільна dev-база (Docker, `solvix-dev`) | db 5434, be 7153, fe 4200 |
| Docker-інстанс N | своя база в кожному (проєкт `solvix-N`, том `solvix_stackN_postgres_data`) | web 8080+N, api 5170+N, db 5440+N |

IDE і термінал займають одні й ті самі порти be/fe, тому працює лише один із них. Docker-інстанси (до 9) ізольовані: окрема мережа, база, том з моделями, порти. Кілька реплік API *всередині* одного інстанса поки не підтримуються: сесії редактора й solver живуть у пам'яті процесу, потрібен спільний стан.

Frontend у режимі `up` ходить на `https://localhost:7153` (`solvix-web/src/environments/environment.ts`), тому API запускається з https. Потрібен dev-сертифікат: `dotnet dev-certs https --trust`.

## Панель керування (`Solvix.Control`)

Окремий ASP.NET Core (Blazor Server) проєкт, який не залежить від інших проєктів Solvix. Показує:

- **Секції**, у кожній одне місце керування: спільна база; **IDE** і **Термінал** (галочки Backend/Frontend + Старт/Стоп); **Docker** (створити N інстансів, у кожного Старт/Стоп/Видалити, свої бази й порти). Для API показує аптайм, пам'ять, CPU, req/s.
- **Хто запустив**: Docker, `solvix` скрипт, IDE (Rider, VS Code, WebStorm…), термінал, інша машина. Для API це приходить від самого API (`SOLVIX_LAUNCHER`, якщо запущено нашим скриптом/Docker, інакше визначається за деревом батьківських процесів); для frontend - за деревом процесів.
- **Логи** API наживо з фільтрами (рівень, інстанс, пошук); зберігаються в `.solvix/logs/entries-*.jsonl`. Вивід `be`/`fe`/контейнерів - кнопка «вивід».
- **IDE**: панель не може натиснути Run у Rider - «Старт» лише готує базу й чекає появи процесу; «Стоп» завершує процес (з підтвердженням).

Як API потрапляє в панель: `Solvix.Api` при старті й кожні 5 с шле панелі свою реєстрацію (`POST /api/instances`), а логи пачками (`POST /api/logs`). Адреса - `Control:Url` (у Development `http://localhost:5200`, у Docker `host.docker.internal:5200`; порожня = вимкнено). Якщо панелі нема - API нічого не помічає. Кожен Docker-інстанс - окрема група в панелі; у майбутньому кілька реплік за load balancer з'являться окремими рядками.

- **Термінал** (`/terminal`): лише читання й перевірка - `docker ps/logs/inspect/stats`, `docker compose ps/logs`, `solvix status…`, `git status/log`, `ls/cat/tail/grep` (тільки в теці проєкту, /tmp, /var/log), `lsof`, `df`, `curl` на localhost. Усе, що змінює або видаляє (`rm`, `docker rm/exec/run`, `git push`, `solvix reset`…), і shell-синтаксис заборонені; `help` показує повний список.
- **Swagger** біля кожного бекенда: у dev - `https://localhost:7153/swagger`, у Docker-інстансі N - `http://localhost:517N/swagger`.

Машинний вигляд стану: `GET http://localhost:5200/api/stack`.

## Docker і Colima

Скрипти самі підіймають Colima, якщо Docker не відповідає. Якщо не стартує: `colima delete && colima start`. `solvix down --colima` зупиняє VM (з підтвердженням, якщо там є чужі контейнери).

## Діагностика

- `solvix doctor` - перевірка середовища і портів.
- `solvix logs be|fe|panel|db [-f]` або `solvix logs stack <N> api|web|postgres` - логи; `solvix logs` - журнал дій.
- Порт зайнятий чужим процесом - `status`/`doctor` покажуть, яким (pid), далі `kill <pid>`.
- Змінити порт спільної бази - `DEV_DB_PORT` у `.env`.
- Дані живуть у docker volume; повне очищення - `solvix reset`, один інстанс - `solvix stack rm N`.
