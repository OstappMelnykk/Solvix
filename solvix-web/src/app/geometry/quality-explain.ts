// What every quality measure means, in words and in formulas. Shown in the popup of a measure's "i" button.
// The formulas follow the code that computes them (Solvix.Fem BrickShape and LinearHexMetrics), so the text and the
// numbers on the ruler describe the same thing. A measure that two tools define differently (aspect ratio) has an entry
// per tool, 'tool:key'; the others are found by the key alone.

export interface MeasureExplain {
  // one or two sentences: what the measure tells
  readonly what: string;
  // the maths, one LaTeX formula per line (drawn with KaTeX)
  readonly formula: readonly string[];
  // what the formula's symbols are, if it needs saying
  readonly where?: readonly string[];
  // what it changes in the result of the calculation
  readonly effect: string;
  // the best value, and what it looks like
  readonly ideal: string;
  // the extreme values: where the element degenerates
  readonly extreme: string;
  // how the number is taken for the whole mesh and where it is computed
  readonly how: string;
  // why the limit is where it is, when it is worth saying
  readonly limitNote?: string;
}

const CORNERS_ONLY = 'Для кожного елемента: по шести гранях і трьох серединних перерізах (кутові вузли). На лінійці — найгірше значення серед усіх елементів сітки.';

const EXPLAIN: Readonly<Record<string, MeasureExplain>> = {
  jacobianRatio: {
    what: 'Наскільки нерівномірно елемент «розтягує» простір. Усередині елемента координати x вираховуються з вузлів через функції форми, а якобіан J — це локальний коефіцієнт зміни об’єму: у скільки разів малий об’єм еталонного куба збільшується в реальному елементі.',
    formula: [
      String.raw`x(\xi,\eta,\zeta)=\sum_{i=1}^{20} N_i(\xi,\eta,\zeta)\,x_i`,
      String.raw`J_{mn}=\frac{\partial x_m}{\partial \xi_n}=\sum_{i=1}^{20}\frac{\partial N_i}{\partial \xi_n}\,x_{i,m}`,
      String.raw`\det J=\begin{vmatrix}J_{11}&J_{12}&J_{13}\\J_{21}&J_{22}&J_{23}\\J_{31}&J_{32}&J_{33}\end{vmatrix}`,
      String.raw`\text{Jacobian ratio}=\frac{\max\det J}{\min\det J}`
    ],
    where: ['det J береться в 21 точці: 20 вузлах елемента і в центрі.', 'Якщо det J має різні знаки — елемент вивернутий, і Solvix вважає його зламаним.'],
    effect: 'Жорсткість елемента й напруження рахуються інтегралом по ξ,η,ζ з множником det J. Чим більше det J змінюється всередині елемента, тим гірше цей інтеграл наближається, а похибка напруження росте. Якщо det J ≤ 0 — інтеграл не має сенсу, розрахунок неможливий.',
    ideal: '1. Усі det J однакові: протилежні грані паралельні, а вузли на серединах ребер стоять рівно посередині (куб, паралелепіпед).',
    extreme: 'Ріст до ∞, коли найменший det J прямує до 0 (елемент складається в плоский). Від’ємне значення ratio означає зміну знака det J, тобто вивернутий елемент.',
    how: 'Рахується по справжньому 20-вузловому елементу, не по кутах. Значення на лінійці — найгірше по сітці.',
    limitNote: 'Solvix не приймає від 30. ANSYS дає попередження на 30 і помилку на 1000. Сильний зсув вузла від середини ребра (на чверть ребра) ломає елемент.'
  },
  'solvix:aspectRatio': {
    what: 'Наскільки грані й перерізи елемента витягнуті. Для кожної грані будується прямокутник на двох бісектрисах (лініях, що з’єднують середини протилежних сторін), і береться відношення його сторін.',
    formula: [
      String.raw`\mathbf a=\mathbf M_{23}-\mathbf M_{01},\qquad \mathbf b=\mathbf M_{30}-\mathbf M_{12}`,
      String.raw`L=\lVert\mathbf a\rVert,\qquad w=\Bigl\lVert \mathbf b-\frac{\mathbf b\cdot\mathbf a}{\mathbf a\cdot\mathbf a}\,\mathbf a\Bigr\rVert`,
      String.raw`AR(\mathbf a)=\max\!\Bigl(\frac{L}{w},\frac{w}{L}\Bigr)`,
      String.raw`\text{Aspect ratio}=\max_{q\in 9}\ \max\bigl(AR(\mathbf a),\,AR(\mathbf b)\bigr)`
    ],
    effect: 'Сам по собі слабо впливає на точність, поки відношення не наближається до сотень. Але у вузькому напрямку градієнти (напруження) змінюються швидко, а елемент малий лише в одному напрямку — це погіршує обумовленість матриці жорсткості й чутливість до помилок округлення.',
    ideal: '1. Квадрат (всі грані й перерізи — квадрати, тобто куб).',
    extreme: 'Не має верхньої межі: зростає до ∞, коли одна сторона прямокутника прямує до 0 (елемент сплющується в пластину чи голку).',
    how: CORNERS_ONLY,
    limitNote: 'Solvix не приймає від 20. ANSYS дозволяє значно більше (помилка на 10⁶), але ми беремо суворіше значення, бо витягнуті елементи важче контролювати.'
  },
  parallelDeviation: {
    what: 'Наскільки протилежні ребра грані чи перерізу не паралельні. Обидві пари протилежних ребер порівнюються як напрямки в одну сторону; береться кут між ними.',
    formula: [
      String.raw`\mathbf e_1=\frac{\mathbf p_1-\mathbf p_0}{\lVert\mathbf p_1-\mathbf p_0\rVert},\qquad \mathbf e_2=\frac{\mathbf p_2-\mathbf p_3}{\lVert\mathbf p_2-\mathbf p_3\rVert}`,
      String.raw`\theta=\arccos(\mathbf e_1\cdot\mathbf e_2)`,
      String.raw`\text{Parallel deviation}=\max_{q\in 9}\ \max\bigl(\theta_{01\parallel 32},\,\theta_{12\parallel 03}\bigr)`
    ],
    where: ['Серединні вузли не враховуються — тільки кутові.'],
    effect: 'Трапецієподібна грань або сильний перекіс змінюють відображення еталонного куба на елемент: якобіан починає мінятися вздовж елемента, а точність напружень падає.',
    ideal: '0°. Протилежні ребра паралельні — прямокутник або паралелограм.',
    extreme: 'До 180°, коли протилежні ребра направлені в протилежні сторони (грань самоперетинається, «метелик»).',
    how: CORNERS_ONLY,
    limitNote: 'Solvix не приймає від 100°. ANSYS дає помилку на 170°.'
  },
  maxCornerAngle: {
    what: 'Найбільший кут у куті грані чи серединного перерізу. Тупий кут погіршує точність і збіжність, бо якобіан у цьому куті стає малим.',
    formula: [
      String.raw`\mathbf u=\mathbf p_{i-1}-\mathbf p_i,\qquad \mathbf v=\mathbf p_{i+1}-\mathbf p_i`,
      String.raw`\theta_i=\arccos\frac{\mathbf u\cdot\mathbf v}{\lVert\mathbf u\rVert\,\lVert\mathbf v\rVert},\qquad i=0,\dots,3`,
      String.raw`\text{Maximum corner angle}=\max_{q\in 9}\ \max_i\theta_i`
    ],
    effect: 'Біля тупого кута det J мінімальний і інтерполяція поля (переміщень) гірша; на межі 180° елемент вироджується, бо три вузли лежать на одній прямій.',
    ideal: '90°. Прямокутник: усі кути прямі.',
    extreme: 'Наближається до 180°, коли кутовий вузол «лягає» на пряму між сусідами. Тоді det J у цьому куті → 0.',
    how: CORNERS_ONLY,
    limitNote: 'Solvix не приймає від 165°. ANSYS дає помилку на 179,9°.'
  },
  minCornerAngle: {
    what: 'Найменший кут у куті грані чи серединного перерізу. Гострий кут так само шкодить, як і тупий: сума кутів опуклого чотирикутника — 360°, тож один гострий кут майже завжди дає тупий, але тупий може ще бути в нормі.',
    formula: [
      String.raw`\mathbf u=\mathbf p_{i-1}-\mathbf p_i,\qquad \mathbf v=\mathbf p_{i+1}-\mathbf p_i`,
      String.raw`\theta_i=\arccos\frac{\mathbf u\cdot\mathbf v}{\lVert\mathbf u\rVert\,\lVert\mathbf v\rVert},\qquad i=0,\dots,3`,
      String.raw`\text{Minimum corner angle}=\min_{q\in 9}\ \min_i\theta_i`
    ],
    effect: 'Біля гострого кута елемент стає «голкою», det J — малий, ряд збіжності гірший, напруження біля цього кута неточні.',
    ideal: '90°. Прямокутник.',
    extreme: 'Прямує до 0°, коли два ребра одного кута зливаються (ребро колапсує).',
    how: CORNERS_ONLY + ' Це не перевірка ANSYS: Solvix додав її сам, бо гострий кут може ховатися за прийнятним найбільшим.',
    limitNote: 'Solvix не приймає менше 15°. Помилки (межі, за якою розрахунок зупиняється) для цієї міри немає.'
  },
  warpingFactor: {
    what: 'Наскільки грань не плоска. Чотири вузли грані в просторі зазвичай не лежать у одній площині: два вузли «вгорі», два «внизу» відносно середньої площини.',
    formula: [
      String.raw`\mathbf N=(\mathbf p_2-\mathbf p_0)\times(\mathbf p_3-\mathbf p_1),\qquad \mathbf n=\frac{\mathbf N}{\lVert\mathbf N\rVert}`,
      String.raw`\mathbf c=\frac14\sum_{i=0}^{3}\mathbf p_i,\qquad h_i=(\mathbf p_i-\mathbf c)\cdot\mathbf n,\qquad A=\tfrac12\lVert\mathbf N\rVert`,
      String.raw`\text{Warping factor}=\max_{6\ \text{faces}}\ \frac{\max_i\,\lvert h_i-h_{i+1}\rvert}{\sqrt{A}}`
    ],
    effect: 'Нормаль до грані перестає бути єдиною, а якобіан змінюється по грані. Це впливає на тиск і контакт на ній (напрямок навантаження) і на точність біля вигнутої грані.',
    ideal: '0. Грань плоска.',
    extreme: 'Не має верхньої межі. Значення порядку 1 означає, що висота перекосу сумірна зі стороною грані.',
    how: 'По шести гранях елемента (кутові вузли). На лінійці — найгірше значення по сітці.',
    limitNote: 'Solvix не приймає від 0,2. ANSYS дає помилку на 0,4.'
  },
  scaledJacobian: {
    what: 'Показує, наскільки кут між трьома ребрами в кутку далекий від прямого. Це визначник із трьох одиничних ребер: об’єм паралелепіпеда, побудованого на трьох одиничних векторах.',
    formula: [
      String.raw`\mathbf e_k=\mathbf p_{\text{neighbour}_k}-\mathbf p_{\text{corner}},\qquad k=1,2,3`,
      String.raw`SJ=\frac{\mathbf e_1\cdot(\mathbf e_2\times\mathbf e_3)}{\lVert\mathbf e_1\rVert\,\lVert\mathbf e_2\rVert\,\lVert\mathbf e_3\rVert}`,
      String.raw`\text{Scaled Jacobian}=\min_{8\ \text{corners}}SJ`
    ],
    effect: 'Одиниця — ортогональні ребра, 0 — три ребра в одній площині (виродження), від’ємне — вивернутий кут. Чим менше значення, тим сильніше скошений кут і гірша точність.',
    ideal: '1. Усі три ребра в кожному куті взаємно перпендикулярні.',
    extreme: '0 — кут сплющений у площину. Менше 0 — елемент вивернутий (мінімум −1).',
    how: 'Рахується тільки по восьми кутових вузлах (прямі ребра), як це роблять Cubit і Verdict. На лінійці — найгірше значення по сітці.',
    limitNote: 'Cubit вважає прийнятним від 0,5. Solvix додав цю міру сам і взяв значно м’якшу межу 0,2.'
  },
  equiangleSkew: {
    what: 'Найбільше відхилення кута грані від 90°, поділене на 90°. Це шкала ANSYS: від 0 (усі кути прямі) до 1 (виродження).',
    formula: [
      String.raw`\text{Skewness}=\max\Bigl(\frac{\theta_{\max}-90^\circ}{90^\circ},\ \frac{90^\circ-\theta_{\min}}{90^\circ}\Bigr)`
    ],
    effect: 'Чим ближче до 1, тим більше елемент схожий на голку чи пластину: гірша інтерполяція й обумовленість. ANSYS вважає 0–0,25 відмінним, 0,25–0,5 добрим, 0,5–0,75 задовільним, 0,9–1 — «голкою».',
    ideal: '0. Усі кути граней прямі.',
    extreme: '1 — виродження: кут 0° або 180°.',
    how: 'Рахується по восьми кутових вузлах і шести гранях (прямі ребра). ANSYS для гексаедрів може рахувати інакше (через нормалі), тож числа можуть відрізнятися.',
    limitNote: 'Solvix не приймає від 0,9. Інструмент ANSYS CFD має чотири рівні: 0,25 | 0,5 | 0,75.'
  },
  faceMinAngle: {
    what: 'Найменший кут між ребрами в кутку грані.',
    formula: [
      String.raw`\theta=\arccos\frac{\mathbf u\cdot\mathbf v}{\lVert\mathbf u\rVert\,\lVert\mathbf v\rVert}`,
      String.raw`\text{Smaller face corner angle}=\min\theta`
    ],
    effect: 'Гострі кути погіршують точність; Abaqus попереджає при куті менше 10°.',
    ideal: '90°.',
    extreme: 'Прямує до 0°, коли два ребра зливаються.',
    how: 'Рахується по восьми кутових вузлах (прямі ребра).'
  },
  faceMaxAngle: {
    what: 'Найбільший кут між ребрами в кутку грані.',
    formula: [
      String.raw`\theta=\arccos\frac{\mathbf u\cdot\mathbf v}{\lVert\mathbf u\rVert\,\lVert\mathbf v\rVert}`,
      String.raw`\text{Larger face corner angle}=\max\theta`
    ],
    effect: 'Тупі кути погіршують точність; Abaqus попереджає при куті більше 160°.',
    ideal: '90°.',
    extreme: 'Прямує до 180°, коли три вузли лягають на одну лінію.',
    how: 'Рахується по восьми кутових вузлах (прямі ребра).'
  },
  'abaqus:aspectRatio': {
    what: 'Відношення довжин найдовшого й найкоротшого з 12 ребер елемента (кутові вузли).',
    formula: [
      String.raw`L_i=\lVert\mathbf p_b-\mathbf p_a\rVert,\qquad i=1,\dots,12`,
      String.raw`\text{Aspect ratio}=\frac{\max_i L_i}{\min_i L_i}`
    ],
    effect: 'Витягнутий елемент гірше наближає поле у вузькому напрямку.',
    ideal: '1. Усі ребра однакової довжини (куб).',
    extreme: 'Без верхньої межі: росте до ∞, коли найкоротше ребро стискається в точку.',
    how: 'Рахується по восьми кутових вузлах (прямі ребра). Abaqus попереджає від 10.'
  },
  'altair:aspectRatio': {
    what: 'Відношення довжин найдовшого й найкоротшого з 12 ребер елемента (кутові вузли).',
    formula: [
      String.raw`L_i=\lVert\mathbf p_b-\mathbf p_a\rVert,\qquad i=1,\dots,12`,
      String.raw`\text{Aspect ratio}=\frac{\max_i L_i}{\min_i L_i}`
    ],
    effect: 'Витягнутий елемент гірше наближає поле у вузькому напрямку.',
    ideal: '1. Усі ребра однакової довжини (куб).',
    extreme: 'Без верхньої межі: росте до ∞, коли найкоротше ребро стискається в точку.',
    how: 'Рахується по восьми кутових вузлах. У довідці HyperMesh значення рідко має перевищувати 5.'
  },
  'cubit:aspectRatio': {
    what: 'Відношення довжин найдовшої й найкоротшої з трьох головних осей елемента в центрі.',
    formula: [
      String.raw`\mathbf X_1=(\mathbf p_1-\mathbf p_0)+(\mathbf p_2-\mathbf p_3)+(\mathbf p_5-\mathbf p_4)+(\mathbf p_6-\mathbf p_7),\quad \mathbf X_2,\ \mathbf X_3\ \text{analogously}`,
      String.raw`L_k=\lVert\mathbf X_k\rVert`,
      String.raw`\text{Aspect ratio}=\frac{\max(L_1,L_2,L_3)}{\min(L_1,L_2,L_3)}`
    ],
    effect: 'Показує загальну витягнутість елемента, а не лише найкоротше ребро.',
    ideal: '1. Усі три осі рівні (куб).',
    extreme: 'Росте до ∞, коли одна з осей стискається в нуль.',
    how: 'Рахується по восьми кутових вузлах. Формула відтворена за описом у довіднику Cubit, а не з коду Verdict. Допустимо 1–4.'
  },
  skew: {
    what: 'Наскільки головні осі елемента не перпендикулярні: найбільший |cos| кута між двома осями.',
    formula: [
      String.raw`\cos(\mathbf A,\mathbf B)=\frac{\mathbf A\cdot\mathbf B}{\lVert\mathbf A\rVert\,\lVert\mathbf B\rVert}`,
      String.raw`\text{Skew}=\max\bigl(\lvert\cos(\mathbf X_1,\mathbf X_2)\rvert,\ \lvert\cos(\mathbf X_1,\mathbf X_3)\rvert,\ \lvert\cos(\mathbf X_2,\mathbf X_3)\rvert\bigr)`
    ],
    effect: 'Скошений елемент гірше наближає напруження: чим більше |cos|, тим ближче дві осі до однієї прямої.',
    ideal: '0. Усі осі взаємно перпендикулярні.',
    extreme: '1. Дві осі паралельні — елемент сплющений.',
    how: 'Рахується по восьми кутових вузлах. Формула відтворена за описом у довіднику Cubit. Допустимо 0–0,5.'
  },
  taper: {
    what: 'Наскільки протилежні ребра різної довжини (елемент схожий на зрізаний конус).',
    formula: [
      String.raw`\mathbf X_{12}=\bigl[(\mathbf p_2-\mathbf p_3)-(\mathbf p_1-\mathbf p_0)\bigr]+\bigl[(\mathbf p_6-\mathbf p_7)-(\mathbf p_5-\mathbf p_4)\bigr],\quad \mathbf X_{13},\ \mathbf X_{23}\ \text{analogously}`,
      String.raw`\text{Taper}=\max_{i<j}\frac{\lVert\mathbf X_{ij}\rVert}{\min(\lVert\mathbf X_i\rVert,\ \lVert\mathbf X_j\rVert)}`
    ],
    effect: 'Зміна перерізу вздовж осі робить якобіан неоднаковим вздовж елемента.',
    ideal: '0. Протилежні ребра однакові.',
    extreme: 'Росте, коли один кінець елемента стискається до точки.',
    how: 'Рахується по восьми кутових вузлах. Формула відтворена за описом у довіднику Cubit. Допустимо 0–0,4.'
  },
  stretch: {
    what: 'Порівнює найкоротше ребро з найдовшою діагоналлю, нормовано так, що для куба це 1.',
    formula: [
      String.raw`\text{Stretch}=\frac{\sqrt{3}\,L_{\min}}{D_{\max}}`
    ],
    effect: 'Мале значення — елемент витягнутий або дуже сплющений.',
    ideal: '1. Куб.',
    extreme: '0, коли найкоротше ребро стискається в нуль.',
    how: 'Рахується по восьми кутових вузлах. Формула відтворена за описом у довіднику Cubit. Допустимо 0,25–1.'
  },
  diagonal: {
    what: 'Відношення найкоротшої діагоналі до найдовшої серед чотирьох просторових діагоналей.',
    formula: [
      String.raw`\text{Diagonal ratio}=\frac{\min_i D_i}{\max_i D_i}`
    ],
    effect: 'Показує, наскільки елемент перекошений: у кубі всі діагоналі однакові.',
    ideal: '1. Усі діагоналі рівні.',
    extreme: 'Прямує до 0, коли одна діагональ стискається.',
    how: 'Рахується по восьми кутових вузлах. Допустимо 0,65–1.'
  },
  condition: {
    what: 'Число обумовленості якобіана в куті: наскільки сильно матриця ребер роздуває чи стискає вектори в найгіршому напрямку.',
    formula: [
      String.raw`A=\begin{bmatrix}\mathbf e_1&\mathbf e_2&\mathbf e_3\end{bmatrix}`,
      String.raw`\kappa(A)=\frac{\lVert A\rVert_F\,\lVert A^{-1}\rVert_F}{3}`,
      String.raw`\text{Condition no.}=\max_{8\ \text{corners}}\kappa(A)`
    ],
    effect: 'Велике число — чутливість до помилок округлення й гірша точність, бо відображення майже вироджене.',
    ideal: '1. Куб.',
    extreme: 'Росте до ∞, коли det A → 0 (кут сплющений).',
    how: 'Рахується по восьми кутових вузлах. Допустимо 1–8.'
  },
  shear: {
    what: 'Якість кутів без урахування довжин ребер: якобіан із ребер, нормованих до одиничної довжини.',
    formula: [
      String.raw`\hat A=\begin{bmatrix}\dfrac{\mathbf e_1}{\lVert\mathbf e_1\rVert}&\dfrac{\mathbf e_2}{\lVert\mathbf e_2\rVert}&\dfrac{\mathbf e_3}{\lVert\mathbf e_3\rVert}\end{bmatrix}`,
      String.raw`\text{Shear}=\min_{8\ \text{corners}}\bigl(\det\hat A\bigr)^{2/3}`
    ],
    effect: 'Менше — кути далекі від прямих, тому елемент скошений.',
    ideal: '1. Усі ребра в кутах перпендикулярні.',
    extreme: '0, коли кут сплющений у площину.',
    how: 'Рахується по восьми кутових вузлах. Допустимо 0,3–1.'
  },
  shape: {
    what: 'Якість форми з урахуванням і кутів, і довжин ребер.',
    formula: [
      String.raw`\text{Shape}=\min_{8\ \text{corners}}\frac{3\,(\det A)^{2/3}}{\lVert A\rVert_F^{\,2}}`
    ],
    effect: 'Менше — елемент далекий від куба (скошений чи витягнутий).',
    ideal: '1. Куб.',
    extreme: '0, коли кут сплющений.',
    how: 'Рахується по восьми кутових вузлах. Допустимо 0,3–1.'
  },
  jacobian: {
    what: 'Відношення найменшого якобіана до найбільшого в точках Гауса (там, де рахується інтеграл).',
    formula: [
      String.raw`\text{Jacobian}=\frac{\min\det J}{\max\det J}\quad(\text{in the Gauss points})`
    ],
    effect: 'Показує, наскільки рівномірно елемент відображається; менше — гірше. Те саме, що у нас «Рівномірність якобіана», тільки перевернуте.',
    ideal: '1. Усі det J однакові.',
    extreme: '0, коли найменший det J прямує до нуля; менше 0 — елемент вивернутий.',
    how: 'Рахується по справжньому елементу. HyperMesh вважає загалом прийнятним від 0,7.'
  }
};

export function explainFor(tool: string, key: string): MeasureExplain | null {
  return EXPLAIN[`${tool}:${key}`] ?? EXPLAIN[key] ?? null;
}
