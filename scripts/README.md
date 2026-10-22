# Скрипти

Один вхід: `./scripts/solvix` (або подвійний клік на `Solvix.command` - меню). Те саме, але в браузері, дає **панель керування** (`Solvix.Control`): `./scripts/solvix panel` → http://localhost:5200.

| Команда | Що робить |
|---|---|
| `solvix panel` | Тільки панель керування. `demo` і `up` піднімають її самі |
| `solvix demo` | Усе в Docker (db + api + web) → http://localhost:8081. Для показу |
| `solvix up [db\|be\|fe\|app\|all]` | Розробка: db у Docker, be/fe локально з hot-reload → http://localhost:4200; `app` - api + web у Docker |
| `solvix status` | Що зараз запущено (порт, pid, аптайм). Показує і чужі процеси на наших портах |
| `solvix down [db\|be\|fe\|app\|panel\|all] [--colima]` | Вимкнути (за замовч. все). `--colima` ще й зупиняє VM |
| `solvix logs [be\|fe\|panel\|db\|api\|web] [-f]` | Логи компонента; без аргументу - журнал дій |
| `solvix doctor` | Перевірка середовища (docker, dotnet, node, сертифікат, порти) |
| `solvix reset` | Вимкнути все і видалити дані бази |

Структура: `solvix` - команди; `lib/common.sh` - вивід, журнал, порти, pid; `lib/docker.sh` - Colima/compose, db, app; `lib/be.sh`, `lib/fe.sh`, `lib/panel.sh` - локальні процеси; `lib/status.sh` - status/logs/doctor.

Стан і логи: `.solvix/` (в git не потрапляє): `run/*.pid`, `logs/{be,fe,panel,db,docker-*}.log`, `logs/solvix.log` - журнал усіх дій, `logs/entries-*.jsonl` - логи, зібрані панеллю від API.

Порти (змінюються в `.env`): db `5434`, web `8081`; фіксовані: panel `5200`, be `7153`/`5168`, fe `4200`.
