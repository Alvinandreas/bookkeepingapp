# Verifikations-grinder — hosting & molnsynk

Guiden delar upp allt i tre delar:
**A)** hosta appen på GitHub Pages, **B)** koppla på Google Sheets-synk, **C)** flytta över din nuvarande data.

Appen består av tre filer som är allt som behövs för att köra sajten:
`index.html`, `style.css`, `script.js`. (`apps-script.gs` och den här `SETUP.md` är bara hjälpfiler.)

---

## A) Hosta på GitHub Pages

1. Skapa ett konto på **github.com** om du inte har ett.
2. Skapa ett nytt **publikt** repo, t.ex. `verifikations-grinder`
   (Pages kräver publikt repo på gratiskonto).
3. **Add file → Upload files** → dra in `index.html`, `style.css`, `script.js` → **Commit changes**.
4. **Settings → Pages** → under *Build and deployment*:
   - Source: **Deploy from a branch**
   - Branch: **main** / **/ (root)** → **Save**
5. Vänta ~1 minut. Din adress blir:
   `https://<ditt-användarnamn>.github.io/verifikations-grinder/`
6. Öppna adressen — appen körs nu hostad, med stabil localStorage. 🎉

> Bokmärk adressen. Härifrån använder du den istället för att dubbelklicka filen.

---

## B) Google Sheets-synk

### 1. Skapa ark + skript
1. Gå till **sheets.new** (skapar ett tomt Google Sheet). Döp det, t.ex. "Verifikations-grinder data".
2. **Tillägg/Extensions → Apps Script**.
3. Radera exempelkoden, klistra in **hela** innehållet från `apps-script.gs`. Spara (💾).

### 2. Deploya som webbapp
1. Klicka **Deploy → New deployment**.
2. Kugghjulet → välj typ **Web app**.
3. Ställ in:
   - **Execute as:** Me
   - **Who has access:** Anyone   ← viktigt för att appen ska kunna nå den
4. **Deploy** → godkänn behörigheterna
   (välj ditt konto → *Advanced* → *Go to project (unsafe)* → *Allow* — det är ditt eget skript).
5. Kopiera **Web app URL** (slutar på `/exec`).

### 3. Koppla in i appen
1. Öppna din hostade app → **Inställningar → Molnsynk**.
2. Klistra in URL:en, klicka utanför fältet (eller **🔄 Synka nu**).
3. Status ska bli **"Synkad …"**. Nu speglas din data till arket och hämtas automatiskt på andra datorer när du öppnar appen där (och anger samma URL).

---

## C) Flytta över din nuvarande data (engångs)

Din gamla data ligger i webbläsarens localStorage för `file://` och följer **inte**
automatiskt med till den hostade adressen (annan "origin"). Flytta den så här:

1. Öppna din **gamla lokala fil** (dubbelklick) → **Inställningar → ⬇️ Exportera JSON**.
2. Öppna din **hostade app** → **Inställningar → ⬆️ Importera JSON** → välj filen.
3. Ställ sedan in molnsynk-URL:en (del B3). Därefter sköts allt i molnet.

---

## Bra att veta

- **Offline funkar fortfarande.** localStorage är den snabba lokala cachen; molnet är backup/synk. Tappar du nätet står det "Offline – sparat lokalt" och synkar när du är uppkopplad igen.
- **Konflikthantering:** senaste ändringen vinner (jämförs via en tidsstämpel). Perfekt för en enanvändare; kör inte samma sekund på två datorer så är det lugnt.
- **Ändrar du Apps Script-koden senare** måste du göra **Deploy → Manage deployments → Edit → Version: New version** (annars körs den gamla koden). En helt ny deployment ger en **ny URL** som du då måste uppdatera i appen.
- **Säkerhet:** vem som helst med URL:en kan tekniskt läsa/skriva till arket. Datan är trivial (antal verifikationer, XP), men dela inte URL:en i onödan. Behöver du extra skydd kan vi lägga till en enkel hemlig nyckel senare.
- **Cellgräns:** en cell rymmer ~50 000 tecken. Din data är liten (långt under det) för ett verksamhetsår, så det räcker gott.
