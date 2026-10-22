# Скрипти

Один вхід: `./scripts/solvix` (або подвійний клік на `Solvix.command` - меню).

| Команда | Що робить |
|---|---|
| `solvix demo` | Усе в Docker (db + api + web) → http://localhost:8081. Для показу |
| `solvix up [db\|be\|fe\|all]` | Розробка: db у Docker, be/fe локально з hot-reload → http://localhost:4200 |
| `solvix status` | Що зараз запущено (порт, pid, аптайм). Показує і чужі процеси на наших портах |
| `solvix down [db\|be\|fe\|app\|all] [--colima]` | Вимкнути (за замовч. все). `--colima` ще й зупиняє VM |
| `solvix logs [be\|fe\|db\|api\|web] [-f]` | Логи компонента; без аргументу - журнал дій |
| `solvix doctor` | Перевірка середовища (docker, dotnet, node, сертифікат, порти) |
| `solvix reset` | Вимкнути все і видалити дані бази |

Структура: `solvix` - команди; `lib/common.sh` - вивід, журнал, порти, pid; `lib/docker.sh` - Colima/compose, db, app; `lib/be.sh`, `lib/fe.sh` - локальні процеси; `lib/status.sh` - status/logs/doctor.

Стан і логи: `.solvix/` (в git не потрапляє): `run/*.pid`, `logs/{be,fe,db,docker-*}.log`, `logs/solvix.log` - журнал усіх дій.

Порти (змінюються в `.env`): db `5434`, web `8081`; фіксовані: be `7153`/`5168`, fe `4200`.
