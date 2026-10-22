# Запуск Solvix

```
./scripts/solvix demo      # усе в Docker -> http://localhost:8081
./scripts/solvix up        # розробка з hot-reload -> http://localhost:4200
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
| Потрібно локально | лише Docker/Colima | + .NET 8 SDK, Node 20+ |

Frontend у режимі `up` ходить на `https://localhost:7153` (`solvix-web/src/environments/environment.ts`), тому скрипт запускає API з https. Потрібен dev-сертифікат: `dotnet dev-certs https --trust`.

## Docker і Colima

Скрипти самі підіймають Colima, якщо Docker не відповідає. Якщо не стартує: `colima delete && colima start`. `solvix down --colima` зупиняє VM (з підтвердженням, якщо там є чужі контейнери).

## Діагностика

- `solvix doctor` - перевірка середовища і портів.
- `solvix logs be|fe|db|api|web [-f]` - логи; `solvix logs` - журнал дій.
- Порт зайнятий чужим процесом - `status`/`doctor` покажуть, яким (pid), далі `kill <pid>`.
- Змінити порти бази/web - `DB_PORT`, `WEB_PORT` у `.env`.
- Дані бази живуть у docker volume; повне очищення - `solvix reset`.
