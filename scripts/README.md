# Скрипти

Один вхід: `./scripts/solvix` (або подвійний клік на `Solvix.command` - меню). Те саме в браузері дає **панель керування** (`Solvix.Control`): `./scripts/solvix panel` → http://localhost:5200.

## Три способи запуску, що не заважають одне одному

| Спосіб | База | Порти |
|---|---|---|
| **IDE** (Rider / WebStorm) і **термінал** (скрипт) | **одна спільна dev-база** | db `5434`, be `7153`/`5168`, fe `4200` |
| **Docker-інстанс N** | **власна база в кожному** (свій том, мережа, api, web) | web `8080+N`, db `5440+N` |

IDE і термінал ділять одні порти be/fe, тож одночасно може працювати лише один із них. Docker-інстансів може бути до 9, вони повністю ізольовані.

| Команда | Що робить |
|---|---|
| `solvix up [db\|be\|fe\|all]` | Dev: спільна база в Docker, be/fe локально з hot-reload → http://localhost:4200 |
| `solvix stack new` | Новий Docker-інстанс (db + api + web) на вільних портах |
| `solvix stack up <N>` / `stop <N\|all>` / `rm <N\|all>` | Запустити / зупинити (дані лишаються) / видалити разом з даними |
| `solvix demo` | Скорочення для `stack up 1` → http://localhost:8081 |
| `solvix panel` | Тільки панель керування. Усі `up` і `stack` піднімають її самі |
| `solvix status` | Що запущено (порт, pid, аптайм); чужі процеси на наших портах теж видно |
| `solvix down [db\|be\|fe\|panel]` | Без аргументів - вимкнути все (dev + усі інстанси + панель) |
| `solvix logs [be\|fe\|panel\|db]` · `logs stack <N> <api\|web\|postgres>` `[-f]` | Логи; без аргументів - журнал дій |
| `solvix doctor` | Перевірка середовища (docker, dotnet, node, сертифікат, порти) |
| `solvix reset` | Вимкнути все і видалити всі дані |

Структура: `solvix` - команди; `lib/common.sh` - вивід, журнал, порти, pid; `lib/docker.sh` - Colima, dev-база, Docker-інстанси; `lib/be.sh`, `lib/fe.sh`, `lib/panel.sh` - локальні процеси; `lib/status.sh` - status/logs/doctor.

Стан і логи: `.solvix/` (в git не потрапляє): `run/*.pid`, `logs/*.log`, `logs/solvix.log` - журнал усіх дій, `logs/entries-*.jsonl` - логи API, зібрані панеллю.

Порт dev-бази змінюється в `.env` (`DEV_DB_PORT`).
