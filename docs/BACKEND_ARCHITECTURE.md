# Backend Architecture — Solvix.Api та суміжні проєкти

Опис .NET-розв'язку: які проєкти існують, хто на кого посилається, і де саме
живе (чи поки не живе) той чи інший алгоритм/клас. Доповнює
`docs/FRONTEND_ARCHITECTURE.md` (той описує лише `solvix-web`) — разом вони
дають повну картину "від кліку у браузері до відповіді сервера і назад".

Ручний редактор: `MeshEditorController` (`api/mesh-editor/{sessionId}/...`,
команди повертають `{ ok, error, state }`, відмова — це `ok: false`, а не HTTP-помилка).

Статус: актуально станом на видалення автоматичної вокселізації
(`feature/remove-auto-voxelization`). Автоматичний пайплайн
"STL → вокселізація → зони" прибрано повністю — сітку гексів тепер будує
користувач вручну в редакторі, а STL лишається лише референс-геометрією, на яку
проєктується результат. Реалізованих HTTP-ендпоінтів для побудови сітки зараз
немає (лишився лише `api/model-library`); `Solvix.Solver`/`Solvix.Bridge`/
`Solvix.MeshBuilder` — заглушки (детально нижче).

---

## Проєкти розв'язку і залежності

```
Solvix.Api
 ├── Solvix.Contracts      (інтерфейси-фасади, спільна "мова" між проєктами)
 ├── Solvix.MeshBuilder
 ├── Solvix.Solver
 ├── Solvix.Bridge
 └── Solvix.Data           (EF Core + Npgsql, DbContext)
```

- **`Solvix.Contracts`** — без залежностей. Містить лише два інтерфейси:
  `Facades/IMeshBuilderFacade.cs` і `Facades/ISolverFacade.cs` (обидва
  **порожні**, жодного члена). Це єдина "спільна мова" — `Solvix.Api` ніколи не
  залежить від `Solvix.MeshBuilder`/`Solvix.Solver` напряму по конкретних
  класах, лише по цих інтерфейсах.
- **`Solvix.MeshBuilder`** — `MeshBuilderFacade : IMeshBuilderFacade`: фасад
  ручного редактора сітки. Стан редагування тримає в пам'яті, окремо на сесію
  клієнта (`MeshEditorSessions`, singleton), і повертає лише DTO з `Contracts`
  (`MeshStateDto`, `MeshCommandResultDto`, ...). Доменну модель бере з `Solvix.Mesh`.
- **`Solvix.Mesh`** — чиста доменна бібліотека без залежностей: 20-вузлові
  криволінійні гексаедри (`Hex20`), сітка з явними сусідами та спільними вузлами
  (`HexMesh`), редактор з undo/redo (`HexMeshEditor`), мапінг ідеальний↔реальний,
  експорт для solver'а (`FemMeshData`: `Positions[n,3]`, `Connectivity[e,20]`).
  Ідеальний світ — ціла решітка (кожен куб = клітинка `(i,j,k)`), реальний —
  довільні позиції вузлів; вузол існує в обох місцях з фіксованою ідеальною
  та рухомою реальною позицією.
- **`Solvix.Solver`** — `SolverFacade : ISolverFacade`, реалізує порожній
  інтерфейс. Нічого не робить — заготовка під майбутній розв'язувач.
- **`Solvix.Bridge`** — клас `Bridge`, приймає `IMeshBuilderFacade` +
  `ISolverFacade` через конструктор, **не має жодного публічного методу**.
  Зареєстрований у DI (`Program.cs`), але ніхто його не інжектить і не
  викликає. Задуманий як міст, що з'єднає результат побудови сітки з
  результатом солвера (детальніше — `docs/IDEAS.md`, R4), коли обидва боки
  матимуть що з'єднувати.
- **`Solvix.Data`** — `SolvixDbContext : DbContext`, **без жодного
  `DbSet<>`**. `Program.cs` викликає `AddDbContext`+`Database.Migrate()` при
  старті, але міграцій ще немає (порожня схема), і `ConnectionStrings:Default`
  у `appsettings.json` (не `.Development.json`) — порожній рядок.

---

## Де зараз НЕМАЄ коду (важливо для планування локального згущення)

- **Жодного класу `Hexahedron`/`Node`/`Mesh`(nodes+elements) немає в жодному
  C#-проєкті.** `docs/IDEAS.md` explicitly позначає цю структуру як
  "(обговорено, не закодовано)".
- **`IMeshBuilderFacade` порожній.** Немає `GetCurrentMesh()`, немає жодної
  операції над сіткою.
- **`ISolverFacade` — порожній.** Немає `Solve(Mesh)`, немає жодного DTO для
  результатів розрахунку.
- **Збереження сітки в БД немає**: стан редактора живе лише в пам'яті процесу
  (`MeshEditorSessions`) і губиться при перезапуску API.
- **`Bridge` — порожній клас без методів.** Зареєстрований у DI, нічого не
  викликає і ніхто не викликає його.

Тобто структура гексів/вузлів, яку будуватиме ручний редактор, — це **новий код
у новому місці** (ймовірний кандидат: `Solvix.MeshBuilder` або окремий проєкт
`Solvix.Mesh`), а не розширення чогось наявного.

## Solver (`Solvix.Solver`, `Solvix.Bridge`, `SolverController`)

The FEM solver is the user's own project (`Solution1/FemSolver`), referenced by path (`FemSolverProject` MSBuild property in `Solvix.Solver.csproj`; override with `-p:FemSolverProject=...` on another machine). `Solvix.Solver` knows nothing about the mesh editor: `ISolverFacade` takes a plain `FemMeshDto` (flat positions + 20-node connectivity), `Solvix.Bridge` is the only place that joins it with `IMeshBuilderFacade.ExportFemMesh`.

- **Set-up per session** (`SolverSetup`): a material library (steel, concrete, rubber, enamel, dentin... plus custom), a material per cube (default for the rest), clamped faces, uniform pressures on faces (Pa, positive = into the body). Keyed by editor hex ids; `Reset` of the mesh clears it (ids restart from 0).
- **Division (as in the solver's mesh)**: every cube is cut into Nx*Ny*Nz small 20-node elements (`FineMesh`), their nodes on a (2n+1)-point grid per axis keeping those with at most one odd index, at x = sum N20(ix/nx-1, ...) * x_parent - exactly the solver's `Mesh.Generate` + `ApplySerendipityMapping`. Nodes on a face two cubes share (all 8 parent nodes equal) are one node, so the body stays one mesh. A cube face is clamped/pressed on every small element on that side. The same numbers draw the inner grid in the editor. The result is returned on the divided mesh (`Positions`, `GridNodes` per cube).
- **Per small face and per element**: supports and pressures are stored per small face (cube, side, cell p,q of the side's grid), materials per cube with overrides per small element. A request without (p, q) means the whole side; changing the division remaps all of it (a new cell belongs to an old one when its centre lies inside it, so a region stays the same region).
- **Pressure**: Pn as in the solver - along the outward normal, negative = compression.
- **Per-cube materials**: `FemRun` assembles the stiffness itself with each element's own Lamé constants (the element physics - `ElementStiffness`, `LoadAssembler`, clamped faces - is the solver's), then solves with a Jacobi-preconditioned CG with progress and cancellation. With one material it equals `FemSolverCore` (tested). Stress is recovered at the Gauss point nearest each node (the node itself is near-singular at the lattice corners of a curved cube) and averaged over the elements sharing it, so across a material interface a node shows a blend.
- **Checks before solving** (`SolverValidator`): no cubes, no support, folded cubes, a separate part without a support (it would float), invalid material, references to deleted cubes, a face both clamped and loaded.
- **Background job**: one per session, with a ticket (a late message of an old run never overwrites a newer one); progress is pushed over SignalR (`/hubs/solver`, `Join(sessionId)`, message `jobChanged(sessionId, job)`) and can be polled (`GET api/solver/{id}/job`).
