/**
 * Google Apps Script för Verifikations-grinder – molnsynk mot Google Sheets.
 *
 * Så här används den:
 *  1. Skapa ett nytt Google Sheet (gå till sheets.new).
 *  2. Extensions/Tillägg → Apps Script.
 *  3. Radera exempelkoden, klistra in HELA den här filen. Spara.
 *  4. Deploy → New deployment → Web app.
 *       - Execute as: Me
 *       - Who has access: Anyone
 *  5. Godkänn behörigheterna, kopiera "Web app URL" (slutar på /exec).
 *  6. Klistra in URL:en i appen: Inställningar → Molnsynk.
 *
 * Datan lagras som en JSON-sträng i cell A1, tidsstämpel i B1, och en läsbar
 * sammanfattning i C1–E1 (bara för din egen skull – appen använder A1/B1).
 */

function doGet() {
  return respond(readState());
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    writeState(body.data, body.updatedAt);
    return respond({ ok: true });
  } catch (err) {
    return respond({ ok: false, error: String(err) });
  }
}

function sheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
}

function readState() {
  var s = sheet();
  var raw = s.getRange('A1').getValue();
  var ts  = s.getRange('B1').getValue();
  var data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (e) {}
  return { ok: true, data: data, updatedAt: Number(ts) || 0 };
}

function writeState(data, updatedAt) {
  var s = sheet();
  s.getRange('A1').setValue(JSON.stringify(data));
  s.getRange('B1').setValue(Number(updatedAt) || Date.now());
  s.getRange('C1').setValue('Senast uppdaterad: ' + new Date());
  // Läsbar sammanfattning (valfritt – syns i arket, appen bryr sig inte om den)
  if (data) {
    s.getRange('D1').setValue('Bokförda: ' + (data.total || 0) + ' / ' + (data.goal || 0));
    s.getRange('E1').setValue('XP: ' + (data.xp || 0) + ' · Level ' + (data.level || 1));
  }
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
