# James Toetsweek 2.3

Een mobile-first PWA en lokale leercoach voor Biologie, Frans, Geschiedenis en
Wiskunde en Aardrijkskunde. Er is geen backend, account of buildstap nodig.

## Lokaal starten

Start in deze map een eenvoudige webserver:

```powershell
python -m http.server 8080
```

Open daarna `http://localhost:8080`.

Je kunt `index.html` ook rechtstreeks openen om de basis te bekijken, maar installatie
en offline caching werken alleen via `http://localhost` of HTTPS.

## Vakken of leerstof toevoegen

Alle leerstof staat in `data.js`. Elk vak bevat:

- metadata en planning;
- `topics` met samenvattingen;
- `flashcards`;
- `questions` met `type`, `correctAnswer`, `explanation` en `difficulty`.

Geschiedenis bevat 15 leeronderwerpen, een tijdlijn, 32 flashcards en 40 toetsvragen.
Wiskunde bevat 15 leeronderwerpen, een formulekaart, 32 flashcards en 40 toetsvragen.
Aardrijkskunde bevat 15 leeronderwerpen, 32 kernbegrippen, 32 flashcards en 40
toetsvragen. Kopieer een bestaand vakobject om Engels interactief te maken. Zet daarna
`enabled: true`. De vakpagina en leerstanden verschijnen automatisch.

## Op een telefoon openen

1. Zorg dat telefoon en computer op hetzelfde wifi-netwerk zitten.
2. Start de server met:

   ```powershell
   python -m http.server 8080 --bind 0.0.0.0
   ```

3. Zoek het lokale IP-adres van de computer met `ipconfig`.
4. Open op de telefoon `http://<IP-ADRES>:8080`.

Voor installatie buiten `localhost` vereisen moderne browsers meestal HTTPS. Publiceer
de map daarom op een statische HTTPS-host zoals GitHub Pages, Netlify of Cloudflare Pages.

## Als PWA installeren

- Android/Chrome: open het browsermenu en kies **App installeren** of
  **Toevoegen aan startscherm**.
- iPhone/Safari: tik op **Delen** en daarna **Zet op beginscherm**.
- In de app staat installatiehulp op het scherm **Score**.

Na de eerste online opening zijn de app-shell en leerdata offline beschikbaar.

## Opslag

Voortgang, XP, levels, badges, streak, foutlijsten, toetsscores en de focustimer worden
in `localStorage` op het apparaat bewaard.
