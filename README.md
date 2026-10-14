# Halloween Outfit Awards 🎃

Dit jaar had ik met vrienden een Halloweenfeest. Iedereen steekt veel tijd in een outfit, en aan het eind van de avond komt altijd dezelfde vraag: wie had de beste? Dit jaar hadden we een prijs voor het beste outfit, dus het was ook handig om een manier te hebben waarmee mensen annoniem konden stemmen op wie het beste outfit heeft, zonder dart ze natuurlijk op zichzelf kunnen stemmen..

Hier zijn natuurlijk genoeg bestaande apps voor, maar dit jaar wilde ik het wat leuker maken. Daarom bouwde ik een kleine stem-app voor één avond.

## Wat de app doet

- **Persoonlijke uitnodiging.** Elke gast krijgt van mij een link met een eigen code van 6 cijfers. Eén klik en je bent binnen.
- **Stemmen op je favoriet.** Je ziet de lijst met gasten en kiest de beste outfit. Op jezelf stemmen kan niet. Van gedachten veranderen mag, zolang de stemming open is.
- **Geheim tot het einde.** Niemand ziet tussendoor hoe het ervoor staat, ook ik niet. Ik zie alleen wie al gestemd heeft, niet op wie.
- **De grote onthulling.** Als ik de stemming sluit, verschijnt de uitslag met de winnaar bovenaan. Bij een gelijkspel krijgen alle koplopers een groene rand, en dan beslist een geimproviseerd spelletje op de avond zelf de winnaar.

Als organisator heb ik een eigen beheerpagina. Daar zet ik gasten op de lijst, kopieer ik hun uitnodiging, start en sluit ik de stemming en bekijk ik de uitslag.

## Hoe het ging

De app stond in oktober 2026 een paar dagen online, alleen voor de vrienden op het feestje. Na Halloween heb ik hem weer offline gehaald. Deze repository bewaar ik als herinnering, en misschien draai ik hem volgend jaar gewoon weer.

Gebouwd met Node.js, Express, SQLite en Docker.

## Zelf proberen

```bash
npm install
ADMIN_CODE={{admin.code}} npm start
```

Open daarna `http://localhost:3000/admin` en log in met `{{admin.code}}`. Tijdens mijn feest was de app via een Cloudflare tunnel en DNS openbaar beschikbaar, omdat niet iedereen op mijn netwerk zat.