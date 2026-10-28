# Оптимальна структура даних для FEM Mesh Editor

Цей документ описує розроблену структуру даних для всього проекту — від інтерактивного редактора до FEM-експорту. Включає обґрунтування вибору, порівняння альтернатив і повні схеми.

---

## 1. Вимоги до структури

Перш ніж обрати структуру, зафіксуємо повний перелік операцій, які вона має підтримувати ефективно:

| Операція | Джерело |
|----------|---------|
| Знайти всіх сусідів гекса (по граням) за O(1) | Owen algorithm, node propagation |
| Знайти всі гекси інцидентні до вузла | Smoothing (Taubin), conformality check |
| Перетягнути кутовий вузол → оновити форму | Ізопараметрична взаємодія |
| Застосувати шаблон (T1/T2/T3/T4) → вставити нові вузли і гекси | Refinement engine |
| Перевірити відсутність висячих вузлів | Conformality validation |
| Обчислити якість (SJ, Aspect Ratio) для кожного елемента | Quality display |
| Зберегти/відновити весь стан у PostgreSQL | Persistence |
| Скасувати/повторити серію дій | Undo/redo stack |
| Експортувати 20-вузлову сітку (C3D20) | FEM export |
| Масштабувати до десятків тисяч елементів | Performance |

---

## 2. Порівняння альтернатив

### 2.1 Integer-grid (відкинуто)

```
Mesh[i,j,k] = Hex
```

**Проблеми:**
- Вимагає регулярної сітки — елементи мають бути вирівняні по осях
- Не підтримує довільне положення hex у просторі (вимога A1)
- Не підтримує криволінійні hex (ізопараметричні координати)
- При refinement матриця стає розрідженою і нерівномірною

### 2.2 Повна Half-Edge (відхилена для 3D)

Класична Half-Edge (HE) для 2D маніфолдів: кожне ребро розбивається на 2 directed half-edges.

Для 3D hex перенесення HE — це Half-Face або Directed Half-Face:
- Кожна грань розбивається на 2 half-face (по одній на кожен гекс)
- Навігація: `HalfFace → Twin`, `HalfFace → Next` (навколо hex)
- Загальна кількість об'єктів: 6 граней × 2 = 12 half-face на hex + 24 directed half-edge + 12 edge midpoints

**Проблеми:**
- Надлишкова складність: hex має фіксовану топологію (6 граней, 8 кутів, 12 ребер — завжди)
- Немає необхідності в generic-traversal (навколо ребра, навколо вузла) — алгоритм Owen потребує лише "сусід по грані"
- Для refinement: після T1/T2 вставляються нові half-face, що ускладнює rebuild
- Складна серіалізація в PostgreSQL

### 2.3 Compact Face-Slot структура (обрана) ✓

Кожен гекс зберігає 6 **FaceSlot** — компактний аналог half-face, але без окремих об'єктів. FaceSlot — це просто пара `(сусідній гекс, індекс грані сусіда)`.

**Переваги:**
- O(1) доступ до будь-якого сусіда: `hex.FaceSlots[i].Neighbor`
- Мінімальна кількість об'єктів у пам'яті
- Легка серіалізація (6 nullable FK на hex)
- Повністю описує topological adjacency без окремої HE-мережі
- Сумісна з refinement: при поділу оновлюються тільки FaceSlot батька і нових дітей

---

## 3. Ядрові сутності

### 3.1 MeshNode — вузол сітки

```csharp
class MeshNode {
    Guid     Id;
    double   X, Y, Z;          // world coordinates (arbitrary, non-normalized)
    bool     IsBoundary;        // on mesh boundary (no neighbor on this side)
    bool     IsConstraint;      // locked for smoothing (user-pinned)
    Guid?    ParentHexId;       // if edge-midpoint node: which hex owns it
    int?     EdgeIndex;         // if edge-midpoint: which of 12 edges (0..11)
}
```

**Два типи вузлів:**

| Тип | Опис | Кількість на hex |
|-----|------|-----------------|
| Corner node | Кутовий вузол. Зберігається у `HexElement.Corners[8]`. Може бути спільним між кількома гексами. Переміщення = drag у редакторі (тільки батьківський hex). | 8 |
| Edge-midpoint node (Q2) | Серединна точка ребра для 20-вузлового елемента (C3D20). Зберігається у `HexElement.EdgeMidpoints[12]`. Обчислюється автоматично як середнє двох кутів; може бути скоригована вручну для кривих граней. | 12 |

Corner nodes **спільні між гексами**: якщо гекс A і гекс B ділять грань, всі 4 кутові вузли цієї грані — одні й ті самі об'єкти MeshNode (однаковий Guid). Це автоматично забезпечує конформність.

Edge-midpoint nodes **не спільні**: кожен гекс має власні 12 midpoint nodes. При FEM-експорті дублікати (з однаковою позицією і ребром) об'єднуються в один глобальний вузол через spatial hash.

### 3.2 HexElement — шестигранник

```csharp
class HexElement {
    Guid            Id;
    MeshNode[8]     Corners;         // v0..v7, canonical ordering (§4)
    MeshNode[12]?   EdgeMidpoints;   // Q2 nodes; null = compute on demand
    FaceSlot[6]     FaceSlots;       // adjacency (§5)
    Guid?           ParentId;        // null = root element
    List<Guid>      ChildrenIds;     // empty = leaf element
    int             Level;           // refinement depth (0 = original)
    TemplateType?   Template;        // T1/T2/T3/T4 applied to create this element
    int?            TemplateCorner;  // for T1: which corner (0..7) was the apex
    int?            TemplateEdge;    // for T2: which edge (0..11) was marked
    int?            TemplateFace;    // for T4: which face (0..5) was marked
    Guid?           ZoneId;          // refinement zone this element belongs to
    bool            IsActive;        // false = deleted (soft delete for undo)
}
```

**Corner ordering** — дивись §4.

**ChildrenIds** зберігають впорядкований список дочірніх елементів після застосування шаблону. Порядок фіксований і визначається шаблоном (§7).

**Template** + **TemplateCorner/Edge/Face** достатньо для повного опису того, як батько розбито. Потрібно для:
- Коректного відновлення after undo
- Розуміння геометрії дочірніх (їх FaceSlots відносно батька)

### 3.3 QuadElement — чотирикутник (2D)

```csharp
class QuadElement {
    Guid           Id;
    MeshNode[4]    Corners;       // v0..v3, CCW ordering
    MeshNode[4]?   EdgeMidpoints; // Q2 nodes for 8-node serendipity (2D analog)
    EdgeSlot[4]    EdgeSlots;     // adjacency: Left, Right, Bottom, Top
    Guid?          ParentId;
    List<Guid>     ChildrenIds;
    int            Level;
    TemplateType?  Template;
    int?           TemplateCorner;
    int?           TemplateEdge;
    Guid?          ZoneId;
    bool           IsActive;
}
```

### 3.4 FaceSlot і EdgeSlot — компактна суміжність

```csharp
struct FaceSlot {
    Guid? NeighborId;        // null = boundary face
    int?  NeighborFaceIndex; // which face index (0..5) in the neighbor corresponds
}

struct EdgeSlot {
    Guid? NeighborId;
    int?  NeighborEdgeIndex; // which edge (0..3) in the neighbor corresponds
}
```

**Зв'язок twin:** якщо `hexA.FaceSlots[f].NeighborId = hexB.Id` і `hexA.FaceSlots[f].NeighborFaceIndex = g`, то `hexB.FaceSlots[g].NeighborId = hexA.Id` і `hexB.FaceSlots[g].NeighborFaceIndex = f`.

Це автоматично підтримується при будь-якій зміні топології (refinement, delete, merge).

### 3.5 Mesh — коренева сутність

```csharp
class Mesh {
    Guid                      Id;
    string                    Name;
    MeshMode                  Mode;         // Hex3D | Quad2D
    Dictionary<Guid, MeshNode>    Nodes;
    Dictionary<Guid, HexElement>  Hexahedra;    // populated if Mode=Hex3D
    Dictionary<Guid, QuadElement> Quads;        // populated if Mode=Quad2D
    List<RefinementZone>      Zones;
    MeshSettings              Settings;

    // In-memory indices (not persisted, rebuilt on load)
    [NonSerialized] NodeAdjacencyIndex NodeIndex;
}
```

### 3.6 RefinementZone — зона рефайнменту

```csharp
class RefinementZone {
    Guid         Id;
    HashSet<Guid> ElementIds;    // elements selected for this refinement pass
    int           NI, NJ, NK;   // subdivision parameters per pass
    int           N3;            // number of propagation stages
    List<StageParams> Stages;    // per-stage ks, n2
}

class StageParams {
    PropagationMode Mode;   // V1 | V2 | V4
    int[]           Ks;     // vertex/edge/face indices
    int             N2;
}

enum PropagationMode { V1, V2, V4 }
```

---

## 4. Угода нумерації вузлів гексаедра

Стандартна нумерація (відповідає `algorithm-3d-theory.md` і Three.js-візуалізаціям):

```
    v3────v2             v7────v6
    │      │    K+  →   │      │
    v0────v1             v4────v5

  Front face (K=0)      Back face (K=1)
```

| Індекс | Назва | Coord (I,J,K) |
|--------|-------|---------------|
| v0 | BLF | (0,0,0) |
| v1 | BRF | (1,0,0) |
| v2 | TRF | (1,1,0) |
| v3 | TLF | (0,1,0) |
| v4 | BLB | (0,0,1) |
| v5 | BRB | (1,0,1) |
| v6 | TRB | (1,1,1) |
| v7 | TLB | (0,1,1) |

### Faces (FaceSlot indices 0..5)

| Idx | Назва | Вузли (CCW зовні) | Напрямок |
|-----|-------|-------------------|---------|
| 0 | Left  (−I) | v0,v4,v7,v3 | −I |
| 1 | Right (+I) | v1,v2,v6,v5 | +I |
| 2 | Bottom (−J) | v0,v1,v5,v4 | −J |
| 3 | Top (+J)    | v2,v3,v7,v6 | +J |
| 4 | Front (−K)  | v0,v3,v2,v1 | −K |
| 5 | Back (+K)   | v4,v5,v6,v7 | +K |

**Opposite faces:** Left↔Right (0↔1), Bottom↔Top (2↔3), Front↔Back (4↔5).

Тобто `faceOpposite(f) = f ^ 1` — XOR з 1 дає протилежну грань.

### Quad edges (EdgeSlot indices 0..3)

| Idx | Назва | Вузли | Напрямок |
|-----|-------|-------|---------|
| 0 | Left  (−I) | v0,v3 | −I |
| 1 | Right (+I) | v1,v2 | +I |
| 2 | Bottom (−J) | v0,v1 | −J |
| 3 | Top (+J)    | v2,v3 | +J |

---

## 5. 12 ребер та Q2 вузли

### Нумерація ребер (EdgeMidpoints[0..11])

| Idx | Ребро (початок→кінець) | Площина |
|-----|----------------------|---------|
| E0  | v0→v1 | Bottom-Front |
| E1  | v1→v2 | Front-Right |
| E2  | v2→v3 | Top-Front |
| E3  | v3→v0 | Front-Left |
| E4  | v4→v5 | Bottom-Back |
| E5  | v5→v6 | Back-Right |
| E6  | v6→v7 | Top-Back |
| E7  | v7→v4 | Back-Left |
| E8  | v0→v4 | Left-Bottom |
| E9  | v1→v5 | Right-Bottom |
| E10 | v2→v6 | Right-Top |
| E11 | v3→v7 | Left-Top |

### Обчислення midpoints за замовчуванням

```csharp
static MeshNode ComputeEdgeMidpoint(HexElement hex, int edgeIdx) {
    var (a, b) = EdgeEndpoints[edgeIdx]; // table above
    return new MeshNode {
        X = (hex.Corners[a].X + hex.Corners[b].X) / 2,
        Y = (hex.Corners[a].Y + hex.Corners[b].Y) / 2,
        Z = (hex.Corners[a].Z + hex.Corners[b].Z) / 2,
        ParentHexId = hex.Id,
        EdgeIndex = edgeIdx
    };
}
```

**Зберігання:** `EdgeMidpoints` ініціалізується як `null`. При першому запиті (FEM export, якість Q2, drag midpoint) — обчислюється і кешується. При переміщенні кутового вузла — кеш скидається для відповідних ребер.

**Стан "зміщено вручну":** якщо користувач переміщує midpoint для кривого hex — встановлюється флаг `IsManuallyAdjusted` на `MeshNode`. Такі вузли НЕ перераховуються автоматично при русі кутів.

---

## 6. Батько-дитина відносини та рівні рефайнменту

```
Level 0:  HexA (original)
           │
           ├── Level 1: HexA_child0  (T1, corner v0)
           ├── Level 1: HexA_child1  (T1, corner v0)
           ├── Level 1: HexA_child2  (T1, corner v0)
           └── Level 1: HexA_child3  (T1, corner v0)
                         │
                         └── Level 2: HexA_child3_child0  (T2, edge E1)
                         └── Level 2: HexA_child3_child1
                         └── Level 2: HexA_child3_child2
```

**Правила:**
1. `ParentId == null` → кореневий елемент (Level 0), був доданий користувачем вручну
2. `ChildrenIds.Count == 0` → листовий елемент (leaf) — відображається і рафінується
3. Після рефайнменту батько НЕ видаляється — залишається у словнику з `IsActive = false`; `ChildrenIds` заповнені
4. Drag дозволено тільки для кореневих елементів (Level 0); але переміщення кутового вузла Level 0 автоматично оновлює позиції успадкованих вузлів у дітях (вони вказують на ті самі `MeshNode` об'єкти)

**Питання спільних вузлів після рефайнменту:**

Після T1 (наприклад, кут v0): діти використовують НОВІ вузли всередині. Зовнішні вузли (межа батька) — спільні між дітьми і між дітьми та сусідніми гексами.

```
T1 з кутом v0: 4 дочірніх hexа в 2D (аналогічно в 3D)
  - Shell nodes: вузли рівня level[0] (межа батька) = ті самі MeshNode що і в батьку
  - Inner nodes: вузли level[1..n] = нові MeshNode, стають спільними між дітьми
```

Спільність визначається за `Guid`: якщо дочірній hex A і дочірній hex B мають в `Corners[k]` один і той самий Guid — це один і той самий MeshNode.

---

## 7. Інваріант конформності

**Інваріант:** кожне ребро сітки поділяється однаково з обох сторін.

**Реалізація через shared nodes:**
- Якщо hex A і hex B ділять грань (A.FaceSlots[f].NeighborId == B.Id): чотири кутових вузли цієї грані — ті самі об'єкти. Неможливо розділити лише з одного боку без розриву shared node.
- При refinement: перш ніж рафінувати hex A — перевірити, чи сусіди вже рафіновані на сумісному рівні. Якщо ні — propagate refinement або заборонити (ValidationResult).

**Validation button:**
```csharp
ValidationResult ValidateConformality(Mesh mesh) {
    foreach (var hex in mesh.ActiveLeafHexes()) {
        foreach (var slot in hex.FaceSlots) {
            if (slot.NeighborId == null) continue;
            var neighbor = mesh.Hexahedra[slot.NeighborId.Value];
            if (neighbor.IsActive) continue; // neighbor is refined
            // neighbor exists but is a parent (IsActive=false) → hanging node possible
            // check if neighbor's children share the exact same face nodes
            if (!VerifySharedFace(hex, neighbor, slot))
                yield return new ValidationError(hex.Id, neighbor.Id, "Hanging node detected");
        }
    }
}
```

---

## 8. In-memory індекси (не зберігаються в БД)

Після завантаження або зміни mesh — перебудовуються:

### NodeAdjacencyIndex

```csharp
class NodeAdjacencyIndex {
    // NodeId → всі hex що містять цей вузол (в Corners або EdgeMidpoints)
    Dictionary<Guid, HashSet<Guid>> NodeToHexes;

    void Rebuild(Mesh mesh);
    void OnNodeMoved(Guid nodeId);                // invalidate Q2 cache for adjacent hexes
    void OnHexAdded(HexElement hex);
    void OnHexRemoved(Guid hexId);
}
```

**Використання:**
- Smoothing: для кожного вузла знайти всі суміжні → обчислити centroid (Laplacian/Taubin)
- Conformality check: для кожного вузла перевірити чи всі суміжні hex мають його в відповідних позиціях
- Drag: оновити EdgeMidpoints кешу для всіх hex що мають цей вузол

### RowColumnIndex (тільки для algorithm passes)

Будується на початку кожного algorithm run (не зберігається):

```csharp
class RowColumnIndex {
    // Для I-pass: згрупувати leaf hexes по I-шару
    Dictionary<int, List<HexElement>> ILayers;
    Dictionary<int, List<HexElement>> JLayers;
    Dictionary<int, List<HexElement>> KLayers;

    void Build(Mesh mesh, RefinementZone zone);
}
```

I-шар визначається топологічно: починаємо з будь-якого hex у зоні, рухаємося по FaceSlot[0] (Left) і FaceSlot[1] (Right) — визначаємо I-колонку. Потім по FaceSlot[2] (Bottom) і FaceSlot[3] (Top) — J-рядок. Аналогічно K.

---

## 9. Undo/Redo стек

Тільки в пам'яті. Не зберігається в БД.

```csharp
class UndoRedoStack {
    Stack<MeshSnapshot> UndoStack;
    Stack<MeshSnapshot> RedoStack;
    int MaxDepth = 50;

    void Push(MeshSnapshot snapshot);
    void Undo(ref Mesh current);
    void Redo(ref Mesh current);
}

class MeshSnapshot {
    // Deep copy of Mesh state at a point in time
    // Includes: all nodes (positions), all elements (topology + template info), all zones
    // Does NOT include: in-memory indices (rebuilt on restore)
    byte[] SerializedState; // or full object graph
}
```

**Що знімається у snapshot:**
- Всі MeshNode з поточними позиціями (включаючи вручну скориговані midpoints)
- Всі HexElement з FaceSlots, ChildrenIds, IsActive
- Всі RefinementZone
- **НЕ** включає in-memory indices (вони відновлюються)

**Коли знімати snapshot:**
- Перед кожним refinement pass
- Перед drag commit (mouse up після drag)
- Перед smooth
- Перед delete / add element

---

## 10. FEM Експорт (C3D20 — 20-вузловий серендипієвий гексаедр)

```csharp
class FemExporter {
    FemMesh Export(Mesh mesh) {
        var leaves = mesh.ActiveLeafHexes();
        var globalNodes = new SpatialNodeDedup();  // dedup by position + tolerance

        foreach (var hex in leaves) {
            // Ensure EdgeMidpoints are computed
            hex.EnsureEdgeMidpoints();
            // Register all 20 nodes globally
            foreach (var corner in hex.Corners)
                globalNodes.GetOrAdd(corner);
            foreach (var mid in hex.EdgeMidpoints)
                globalNodes.GetOrAdd(mid);
        }

        // Build connectivity (20 indices per element, Abaqus ordering)
        var connectivity = leaves.Select(hex => BuildC3D20Connectivity(hex, globalNodes));
        return new FemMesh(globalNodes.ToList(), connectivity.ToList());
    }
}
```

**C3D20 ordering** (Abaqus standard — відрізняється від нашої внутрішньої нумерації):

| Abaqus idx | Наш вузол |
|-----------|-----------|
| 1 | v0 |
| 2 | v1 |
| 3 | v2 |
| 4 | v3 |
| 5 | v4 |
| 6 | v5 |
| 7 | v6 |
| 8 | v7 |
| 9 | E0 (v0-v1) |
| 10 | E1 (v1-v2) |
| 11 | E2 (v2-v3) |
| 12 | E3 (v3-v0) |
| 13 | E4 (v4-v5) |
| 14 | E5 (v5-v6) |
| 15 | E6 (v6-v7) |
| 16 | E7 (v7-v4) |
| 17 | E8 (v0-v4) |
| 18 | E9 (v1-v5) |
| 19 | E10 (v2-v6) |
| 20 | E11 (v3-v7) |

---

## 11. PostgreSQL схема

### Таблиці

```sql
-- Mesh (сіткова геометрія)
CREATE TABLE meshes (
    id          UUID PRIMARY KEY,
    name        TEXT NOT NULL,
    mode        TEXT NOT NULL CHECK (mode IN ('Hex3D', 'Quad2D')),
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Вузли
CREATE TABLE mesh_nodes (
    id              UUID PRIMARY KEY,
    mesh_id         UUID REFERENCES meshes(id) ON DELETE CASCADE,
    x               DOUBLE PRECISION NOT NULL,
    y               DOUBLE PRECISION NOT NULL,
    z               DOUBLE PRECISION NOT NULL,
    is_boundary     BOOLEAN NOT NULL DEFAULT FALSE,
    is_constraint   BOOLEAN NOT NULL DEFAULT FALSE,
    parent_hex_id   UUID,          -- null = corner node
    edge_index      SMALLINT,      -- 0..11 if edge-midpoint
    is_manual_adj   BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX idx_nodes_mesh ON mesh_nodes(mesh_id);

-- Hex-елементи
CREATE TABLE hex_elements (
    id              UUID PRIMARY KEY,
    mesh_id         UUID REFERENCES meshes(id) ON DELETE CASCADE,
    -- 8 corners (Guid references, ordered v0..v7)
    corner_0        UUID REFERENCES mesh_nodes(id),
    corner_1        UUID REFERENCES mesh_nodes(id),
    corner_2        UUID REFERENCES mesh_nodes(id),
    corner_3        UUID REFERENCES mesh_nodes(id),
    corner_4        UUID REFERENCES mesh_nodes(id),
    corner_5        UUID REFERENCES mesh_nodes(id),
    corner_6        UUID REFERENCES mesh_nodes(id),
    corner_7        UUID REFERENCES mesh_nodes(id),
    -- 6 face slots (neighbor id + neighbor face index)
    face_0_neighbor UUID REFERENCES hex_elements(id),
    face_0_nfi      SMALLINT,
    face_1_neighbor UUID REFERENCES hex_elements(id),
    face_1_nfi      SMALLINT,
    face_2_neighbor UUID REFERENCES hex_elements(id),
    face_2_nfi      SMALLINT,
    face_3_neighbor UUID REFERENCES hex_elements(id),
    face_3_nfi      SMALLINT,
    face_4_neighbor UUID REFERENCES hex_elements(id),
    face_4_nfi      SMALLINT,
    face_5_neighbor UUID REFERENCES hex_elements(id),
    face_5_nfi      SMALLINT,
    -- hierarchy
    parent_id       UUID REFERENCES hex_elements(id),
    level           SMALLINT NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    -- template info
    template        TEXT,          -- 'T1'|'T2'|'T3'|'T4'
    template_corner SMALLINT,
    template_edge   SMALLINT,
    template_face   SMALLINT,
    zone_id         UUID
);
CREATE INDEX idx_hex_mesh ON hex_elements(mesh_id);
CREATE INDEX idx_hex_parent ON hex_elements(parent_id);
CREATE INDEX idx_hex_active ON hex_elements(mesh_id, is_active);

-- Quad-елементи (2D, аналогічно)
CREATE TABLE quad_elements (
    id              UUID PRIMARY KEY,
    mesh_id         UUID REFERENCES meshes(id) ON DELETE CASCADE,
    corner_0        UUID REFERENCES mesh_nodes(id),
    corner_1        UUID REFERENCES mesh_nodes(id),
    corner_2        UUID REFERENCES mesh_nodes(id),
    corner_3        UUID REFERENCES mesh_nodes(id),
    edge_0_neighbor UUID REFERENCES quad_elements(id),
    edge_0_nei      SMALLINT,
    edge_1_neighbor UUID REFERENCES quad_elements(id),
    edge_1_nei      SMALLINT,
    edge_2_neighbor UUID REFERENCES quad_elements(id),
    edge_2_nei      SMALLINT,
    edge_3_neighbor UUID REFERENCES quad_elements(id),
    edge_3_nei      SMALLINT,
    parent_id       UUID REFERENCES quad_elements(id),
    level           SMALLINT NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    template        TEXT,
    template_corner SMALLINT,
    template_edge   SMALLINT,
    zone_id         UUID
);

-- Зони рефайнменту
CREATE TABLE refinement_zones (
    id          UUID PRIMARY KEY,
    mesh_id     UUID REFERENCES meshes(id) ON DELETE CASCADE,
    ni          SMALLINT NOT NULL DEFAULT 2,
    nj          SMALLINT NOT NULL DEFAULT 2,
    nk          SMALLINT NOT NULL DEFAULT 2,
    n3          SMALLINT NOT NULL DEFAULT 1
);

CREATE TABLE zone_elements (
    zone_id     UUID REFERENCES refinement_zones(id),
    element_id  UUID,
    PRIMARY KEY (zone_id, element_id)
);

CREATE TABLE zone_stages (
    zone_id     UUID REFERENCES refinement_zones(id),
    stage_idx   SMALLINT NOT NULL,
    mode        TEXT NOT NULL,  -- 'V1'|'V2'|'V4'
    ks          SMALLINT[] NOT NULL,
    n2          SMALLINT NOT NULL DEFAULT 2,
    PRIMARY KEY (zone_id, stage_idx)
);

-- Бібліотека готових геометрій (шаблони hex для вставки)
CREATE TABLE geometry_library (
    id          UUID PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    mesh_json   JSONB NOT NULL,  -- серіалізована Mesh (nodes + elements)
    thumbnail   BYTEA
);
```

**Edge-midpoint nodes** НЕ зберігаються окремо, якщо `is_manual_adj = false` — вони обчислюються при завантаженні. Зберігаються тільки ті де `is_manual_adj = true`.

---

## 12. Чому ця структура — підсумок переваг

| Аспект | Наша структура | Half-Edge | Integer-grid |
|--------|---------------|-----------|--------------|
| Довільне положення hex | ✓ | ✓ | ✗ |
| O(1) доступ до сусіда | ✓ (FaceSlot[f]) | ✓ | ✓ |
| Мінімум об'єктів | ✓ (~6 slots/hex) | ✗ (24 HE/hex) | ✓ |
| Isoparametric drag | ✓ (Corners[8] direct) | ～ (traversal) | ✗ |
| Parent-child refinement | ✓ (direct refs) | ～ (rebuild HE) | ✗ |
| FEM 20-node export | ✓ (EdgeMidpoints[12]) | ～ (collect via edges) | ✗ |
| PostgreSQL serialization | ✓ (6 FK columns) | ✗ (complex) | ✓ |
| Conformality guarantee | ✓ (shared MeshNode) | ✓ | ✓ |
| Scalable to 100k hexes | ✓ | ✓ | ✗ |

**Ключове: спільні `MeshNode` між гексами** — це єдиний механізм, який автоматично забезпечує конформність без додаткових перевірок. Два гекси, що ділять грань, мають буквально одні й ті самі об'єкти у своїх `Corners[k]`. Переміщення вузла через drag — оновлює обидва гекси одночасно, автоматично.

---

## 13. Початковий hex — unit cube

Коли користувач додає перший hex (клік у сцені або drag з панелі):

```csharp
HexElement CreateUnitCube(Vector3 origin) {
    var nodes = new MeshNode[8];
    // Standard unit cube offsets
    var offsets = new (double,double,double)[] {
        (0,0,0),(1,0,0),(1,1,0),(0,1,0),
        (0,0,1),(1,0,1),(1,1,1),(0,1,1)
    };
    for (int i = 0; i < 8; i++)
        nodes[i] = new MeshNode {
            Id = Guid.NewGuid(),
            X = origin.X + offsets[i].Item1,
            Y = origin.Y + offsets[i].Item2,
            Z = origin.Z + offsets[i].Item3
        };
    return new HexElement {
        Id = Guid.NewGuid(),
        Corners = nodes,
        FaceSlots = new FaceSlot[6], // all null = boundary
        Level = 0
    };
}
```

Після drag: переміщення будь-якого з 8 кутів → оновлення `MeshNode.X,Y,Z` → перерахунок `EdgeMidpoints` (якщо кешовані) → оновлення Three.js геометрії через `setAttribute`.

---

## 14. Зв'язок з ізопараметричним перетворенням

З §9 `algorithm-3d-improvements.md`:

```
(X,Y,Z) = Σᵢ₌₁²⁰ Nᵢ(ξ,η,ζ) · (Xᵢ,Yᵢ,Zᵢ)
```

де `(Xᵢ,Yᵢ,Zᵢ)` — `Corners[0..7]` + `EdgeMidpoints[0..11]` поточного hex.

**Для drag (frontend, Three.js):**
1. Користувач переміщує corner node батьківського hex (Level 0)
2. Оновлюється `MeshNode.X,Y,Z`
3. Three.js перераховує `Calculate(ξ,η,ζ)` **тільки для дочірніх вузлів цього батьківського елемента** — тобто всіх вузлів що належать до його піддерева (Corners і EdgeMidpoints його листових дітей). Інші гекси в сцені не чіпаються.
4. `setAttribute('position', ...)` — GPU оновлення тільки для буферів цього батьківського hex

**Для refinement (backend, .NET):**
- Нові вузли всередині refined hex обчислюються через `lerp3` (Q1, лінійний) або ізопараметрично (Q2, якщо батьківський hex має скориговані midpoints)
- Результат: нові `MeshNode` з точними фізичними координатами

**Відповідність структура ↔ ізопараметрична функція:**
- `DEFAULT_POINTS[0..19]` з frontend = референсні координати (фіксовані константи)
- `Corners[0..7]` + `EdgeMidpoints[0..11]` = фізичні координати поточного hex
- `Calculate(ξ,η,ζ)` = відображення з референсного в фізичний простір