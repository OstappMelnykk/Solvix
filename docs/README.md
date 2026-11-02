# docs: структура

Три блоки: **магістерська**, **курсова**, **проєкт**. У кожній папці є свій `README.md` з коротким поясненням.

```
docs/
├── README.md
│
├── thesis/                           МАГІСТЕРСЬКА
│   ├── Магістерська-робота.docx          текст роботи
│   ├── requirements/                     вимоги: методички, вимоги.md
│   ├── presentation/                     матеріали презентації (templates/)
│   ├── animations/                       анімації до захисту
│   ├── sources/                          література: Owen 2016, fem-theory/, solver/
│   └── helpers/                          допоміжне (порожньо)
│
├── coursework/                       КУРСОВА (coursework.pdf/.docx)
│   ├── presentation/
│   ├── reusable/                         що з курсової взяти в магістерську
│   └── helpers/                          tex, чернетки
│
├── project/                          ПОТОЧНИЙ ПРОЄКТ (Solvix)
│   ├── guides/                           RUNNING, BRANCHING, EDITOR_SHORTCUTS
│   ├── architecture/                     BACKEND_, FRONTEND_ARCHITECTURE, ISOPARAMETRIC, GEOMETRY_RULES
│   ├── planning/                         ROADMAP, FIX_LIST, IDEAS, REVIEW
│   ├── algorithms/                       ALGORITHM, PROBLEMS (згущення)
│   └── research/                         ДОСЛІДЖЕННЯ
│       ├── 01-refinement/                    згущення 3D
│       ├── 02-quality/                       критерій якості сітки
│       └── 03-smoothing/                     згладжування
│
└── archive/                          застаріле (порожньо)
```

## Правила

1. **Один блок, одна тема.** Магістерська, курсова й проєкт не змішуються; чужі файли не лежать поруч із нашими.
2. **У корені блоку лише головний файл і `README.md`.** Усе інше в підпапках.
3. **Однаково названі речі в обох роботах:** `requirements`, `presentation`, `helpers`.
4. **Назви папок:** англійською, нижній регістр, слова через дефіс. Назви файлів не змінюємо.
5. **Дослідження:** `NN-коротка-назва`, у кожному `README.md` про що воно.
6. **У кожній папці є `README.md`.**
7. **`helpers/`** містить службові файли (tex, чернетки), щоб не перебудовувати зроблене. Для читання вони не призначені.

## Не зроблено

- **`project/research/04-smoothing-sota`:** лежить у гілці `feature/smoothing-research`, з'явиться після злиття.
- **`thesis/sources`, `helpers`, `archive`:** порожні, чекають файлів.
- **Шапка з датою й статусом** у кожному документі: пропозиція, не введена.
- **Важкі файли** (`thesis/animations`, 43 МБ): рішення, класти в git чи ні, ще не прийнято.
