# Ідеї (не зафіксовано, не реалізовано)

Цей файл — "парковка" для обговорених ідей, які ще не стали правилом (`GEOMETRY_RULES.md`) чи кодом. Нічого тут не є остаточним рішенням. Коли ідея дозріває — переноситься звідси в реальний документ/код, і рядок тут видаляється.

---

## R3 (кандидат) — заповнення довільної геометрії кубиками фіксованого розміру

Задача: дано тіло довільної форми (напр. сфера, або довільна geometry з Blender) і фіксований розмір кубика (напр. сторона 1). Знайти мінімальну кількість кубиків, які повністю покривають об'єм тіла (сумарний об'єм ≥ об'єм тіла).

Метод: **conservative voxelization на рівномірній сітці**. Для кожного кубика сітки — тест перетину з тілом (для сфери: відстань від центра сфери до найближчої точки кубика ≤ радіус). Кубик включається, якщо перетинається хоч трохи.

Для довільної (не сферичної) геометрії — потрібен **watertight (замкнений) мещ** з Blender, і тест "точка всередині тіла" через ray casting або winding number.

---

## R4 (кандидат) — Topology vs Coordinates, Worlds

Розділення:
- **Topology** — спільна структура (які гекси, батько/дитина, сусіди) — одна на всі світи.
- **World** — власна реалізація координат + власні transform-параметри, окремо для кожного світу.

Операція (напр. `RefineHex`) рахується один раз (в Ideal World), потім **replay** — та сама команда застосовується до кожного іншого світу з його власними координатами.

**Відкрите питання:** як саме зберігати World-стан —
1. Пряме зберігання (мутація `World.Coordinates` напряму) — простіше.
2. Event sourcing (лог операцій + World як проекція/replay) — потужніше (безкоштовний undo/redo), але важче.

Рішення не прийняте.

**3 світи (робоча назва):**
1. **Ideal World** — ідеальні (неспотворені) кубики, тут рахується сам алгоритм T1-T4 (шаблони потребують правильної форми).
2. **Real/Arbitrary World** — реальна геометрія користувача (можливо викривлена), координати виводяться через replay операцій з Ideal.
3. **Solver World** — Real World geometry + результати розрахунку Solver'а (напруження, переміщення), збирається через `Bridge`.

Можливо, знадобиться 4-й світ — не вирішено.

Доступ: лише 1 світ активний (write), інші 2 — read-only. Обмеження лише на рівні "хто активний", не на типи операцій.

**Зв'язок:** `IsoparametricMapper.cs` у `/Users/ostap/Desktop/Vovk/MastersDegreeProject/CadEditor/CadEditor/CadEditor.MeshKernel/Domain/Mesh3D/` — ймовірно, вже реалізує саме цей replay/mapping механізм. Перевірити, коли повернемось до того проєкту.

---

## Форма контракту `Mesh` (обговорено, не закодовано)

```
Mesh { Nodes: MeshNode[], Elements: HexElement[], SchemaVersion }
MeshNode { Id, X, Y, Z }
HexElement { Id, NodeIds[8] }
```

Валідація — окремо, через `IMeshValidationRule` + `MeshValidationResult`, реалізації правил (R1, R2, ...) — у `MeshBuilder`, не в `Contracts`.

`Mesh` — "тупий" POCO, без методів, для вільної серіалізації (`System.Text.Json`).

---

## Facade-патерн для Solver/MeshBuilder (обговорено, не закодовано)

```csharp
public interface IMeshBuilderFacade { Mesh GetCurrentMesh(); }
public interface ISolverFacade { SolveResult Solve(Mesh mesh); }
```

`Bridge` отримує обидва інтерфейси через конструктор (DI), не через project reference. `Api` — composition root, реєструє конкретні реалізації в DI.

**Відкрите питання:** що саме, крім `Mesh`, потрібно передавати в `Solve()` — граничні умови, матеріал тощо. Окремий `SolveRequest` контракт, чи розширювати пізніше?

---

## Іменовані алгоритми/джерела для локального згущення гексів (дослідження)

- **Schneiders**, "Refining Quadrilateral and Hexahedral Element Meshes" — базова робота про transition-шаблони (conforming, без висячих вузлів).
- **Owen, Shih, Ernst**, "A Template-Based Approach for Parallel Hexahedral Two-Refinement" — 2-refinement, 4 шаблони, node marking + propagation. Повний текст: `docs/references/` (в `MastersDegreeProject`, повніша версія ніж наш постер).
- **"Element-Saving Hexahedral 3-Refinement Templates"** (arXiv, 2026) — новіша, ефективніша версія 3-refinement.
- **p4est/p8est** — forest-of-octrees, 2:1 balance, hanging-node + constraints (альтернативний підхід, не conforming).
- Індустрійний висновок: зрілі бібліотеки (MFEM, deal.II, p4est) обрали **hanging-node + constraints**, не conforming-templates — це сильний сигнал не намагатись реалізувати повний conforming-refinement самостійно.

---

## Хостинг (обговорено, не реалізовано до кінця)

- **Сервер:** Oracle Cloud Always Free, Ampere A1 (зараз ліміт **2 OCPU/12GB**, не 4/24 — зменшено Oracle у червні 2026). VCN `solvix-vcn` + public subnet вже створені в Oracle-консолі. Інстанс ще не створено — "out of capacity" у Frankfurt (AD-1/2/3), очікує вільного місця.
- **Доступ:** Cloudflare Tunnel + Cloudflare Access (email-based), не IP-based.
- **CD:** GitHub Actions, збірка Docker-образів → GHCR → SSH деплой на сервер. Ще не написано (тільки CI є).
- **Для швидкого демо** (якщо потрібно раніше, ніж з'явиться Oracle-сервер): запустити `docker compose up` локально + Cloudflare Tunnel тимчасово.

---

## Зв'язок з MastersDegreeProject

`/Users/ostap/Desktop/Vovk/MastersDegreeProject` — попередній, більш зрілий проєкт (CadEditor + LocalMeshRefinement) з робочою (але багованою) 3D-реалізацією T1/T2/T4-шаблонів, Face-Slot структурою даних, Two-phase workflow. Детальніше — у пам'яті сесії (`mastersdegreeproject_relation`). Повернутись, коли дійдемо до реальної реалізації MeshBuilder.