# Refinement 3D (сторінка)

Окремий проєкт Vite + TypeScript + three.js для перегляду 3D-згущення (без зв'язку з Solvix). Ядро — `Refinement3D.Core`, API — `Refinement3D.Api`.

1. Запустіть API: профіль `Refinement3D.Api` (Rider) або `dotnet run --project Refinement3D/Refinement3D.Api` — http://localhost:5191.
2. У цій папці: `npm install`, потім `npm run dev` (WebStorm: ▶ біля скрипта `dev` у `package.json`) — http://localhost:5174.

Клік по клітинці додає її в M, Shift+клік — усі клітинки кореня. «Згустити по кроках» веде майстер: шви шарів, власний шов клітинки, мітки, шаблони, розширення M. «Розріз» ховає шари сітки вздовж осі, щоб було видно всередину.
