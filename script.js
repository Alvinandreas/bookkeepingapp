/* ════════════════════════════════════════════════════════════════════════════
   Verifikations-grinder — applogik
   ────────────────────────────────────────────────────────────────────────────
   Vanilla JS, ingen byggkedja. Laddas som klassiskt <script> sist i <body>.

   Struktur (uppifrån och ned):
     1. TUNE / RANKS ....... trimbara spelparametrar
     2. Store .............. modulärt persistens-lager (lokalt + valfritt moln)
     3. State .............. freshState/load/save + molnsynk
     4. Level-matematik .... XP-kurva och rangtitlar
     5. Ljud / konfetti .... effekter
     6. Kärnloop ........... handleBokford (klick → XP, combo, critical, render)
     7. Streak / achievements
     8. Rendering .......... dashboards, diagram (Chart.js), carousell
     9. Inställningar ...... modaler, export/import, reset
    10. Init .............. koppling av allt vid start
   ════════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
   ⚙️  TRIMBARA INSTÄLLNINGAR  – ändra fritt här
   ══════════════════════════════════════════════════════════════════════════ */
const TUNE = {
  XP_PER_VERIF:    10,    // Bas-XP per bokförd verifikation
  COMBO_WINDOW:    4000,  // ms mellan klick för att bygga combo (4 sek)
  COMBO_MAX:       10,    // Maxtak på combo-multiplikatorn
  CRIT_CHANCE:     0.13,  // Sannolikhet för CRITICAL (0.13 = 13 %)
  CRIT_MULT:       3,     // XP-multiplikator vid critical
  STREAK_BONUS_XP: 5,     // Fast bonus-XP per klick när en streak (>1 dag) är aktiv
  DEFAULT_GOAL:    250,   // Standardmål antal verifikationer
  // Level-kurva: XP som krävs för att nå level n = BASE * n^EXP  (eskalerande)
  LEVEL_BASE:      100,
  LEVEL_EXP:       1.55,
};

/* Rang-titlar per level-tröskel (bokföringstema).
   Level 1 använder index 0, osv. Sista gäller för alla högre levlar. */
const RANKS = [
  "Kvittonovis",          // Lv 1
  "Verifikationsväktare", // Lv 2
  "Kontoklättrare",       // Lv 3
  "Debet-Demon",          // Lv 4
  "Kredit-Krigare",       // Lv 5
  "Momsmagiker",          // Lv 6
  "Avstämnings-Ande",     // Lv 7
  "Balansmästare",        // Lv 8
  "Resultat-Regent",      // Lv 9
  "Huvudboks-Hjälte",     // Lv 10
  "Bokslutsbaron",        // Lv 11
  "Revisor-Riddare",      // Lv 12
  "Bokföringsgud",        // Lv 13+
];

/* ══════════════════════════════════════════════════════════════════════════
   💾  STATE / PERSISTENS
   ══════════════════════════════════════════════════════════════════════════ */
/* ────────────────────────────────────────────────────────────────────────
   Store — modulärt persistens-lager
   ────────────────────────────────────────────────────────────────────────
   All lagring går genom `Store`. Resten av appen anropar bara load()/save()
   och bryr sig inte om VAR datan hamnar. Två backends idag:
     • Lokalt → localStorage (snabb cache, alltid på)
     • Moln   → Google Sheets via Apps Script (valfritt, aktiveras med URL)

   👉 FRAMTID – flera användare:
      Sätt `Store.namespace = <användar-id>` efter inloggning → separata
      localStorage-nycklar per användare. Byt `cloudRead`/`cloudWrite` mot en
      autentiserad API-klient med samma gränssnitt. Ingen övrig appkod ändras.
   ──────────────────────────────────────────────────────────────────────── */
const Store = {
  BASE_KEY:  "gateai_verif_grinder_v1",
  SYNC_KEY:  "gateai_sync_url_v1",   // Apps Script-URL lagras separat (läcker ej via synk)
  namespace: "default",              // FRAMTID: byt till användar-id vid inloggning
  syncUrl:   "",
  _pushTimer: null,

  // localStorage-nyckel (namespacad – "default" behåller den ursprungliga nyckeln)
  localKey(){ return this.namespace === "default" ? this.BASE_KEY : this.BASE_KEY + ":" + this.namespace; },

  // ── Lokal backend ──
  readLocal(){
    try{ const raw = localStorage.getItem(this.localKey()); return raw ? JSON.parse(raw) : null; }
    catch(e){ console.warn("Store: kunde inte läsa lokalt:", e); return null; }
  },
  writeLocal(state){
    try{ localStorage.setItem(this.localKey(), JSON.stringify(state)); }
    catch(e){ console.warn("Store: kunde inte spara lokalt:", e); }
  },

  // ── Molnkonfiguration ──
  loadSyncUrl(){ this.syncUrl = localStorage.getItem(this.SYNC_KEY) || ""; return this.syncUrl; },
  saveSyncUrl(url){
    this.syncUrl = url;
    try{ localStorage.setItem(this.SYNC_KEY, url); }catch(e){}
  },
  cloudEnabled(){ return !!this.syncUrl; },

  // ── Moln-backend (Google Sheets via Apps Script) ──
  // text/plain undviker CORS-preflight som Apps Script inte hanterar.
  cloudRead(){ return fetch(this.syncUrl, { method:"GET" }).then(r => r.json()); },
  cloudWrite(payload){
    return fetch(this.syncUrl, {
      method:  "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body:    JSON.stringify(payload)
    }).then(r => r.json());
  },

  // Debounce så att en snabb combo inte spammar molnet – pushar 2,5 s efter sista ändringen
  schedulePush(fn){
    if(!this.cloudEnabled()) return;
    clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(fn, 2500);
  }
};

function todayKey(d){ // "YYYY-MM-DD" lokal tid
  d = d || new Date();
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}

function freshState(){
  return {
    total: 0,             // totalt antal bokförda
    xp: 0,                // total ackumulerad XP
    level: 1,
    critCount: 0,
    goal: TUNE.DEFAULT_GOAL,
    muted: false,
    reduceMotion: false,
    byDay: {},            // { "2026-07-18": {count, xp} }
    xpLog: [],            // [{t: epoch_ms, xp: totalXP}] – snapshots för XP-graf
    streakCur: 0,
    streakBest: 0,
    lastActiveDay: null,  // "YYYY-MM-DD"
    bestDay: 0,           // högsta antal på en enskild dag
    achievements: {},     // { id:true }
    history: [],          // stack av klick för undo: {day, xp, wasCrit, prevLevel...}
    firstMinuteBurst: [], // tidsstämplar för "10 på 5 min"
    updatedAt: 0,         // epoch ms för senaste ändring – används för molnsynk (last-write-wins)
  };
}

let S = load();

/** Läser statet från lokal lagring och kompletterar med ev. nya standardfält. */
function load(){
  return Object.assign(freshState(), Store.readLocal() || {});
}

/**
 * Sparar statet lokalt och (om molnsynk är på) schemalägger en molnpush.
 * @param {{bump?: boolean}} [opts] bump=false vid data hämtad från molnet:
 *        rör inte tidsstämpeln och pusha inte tillbaka.
 */
function save(opts){
  opts = opts || {};
  if(opts.bump !== false) S.updatedAt = Date.now();
  Store.writeLocal(S);
  if(opts.bump !== false) Store.schedulePush(pushCloud);
}

/* ══════════════════════════════════════════════════════════════════════════
   ☁️  MOLNSYNK  (Google Sheets via Apps Script – valfritt)
   Aktiveras när en Apps Script-URL angetts i Inställningar. Utan URL beter sig
   appen exakt som förut (bara localStorage). Strategi: last-write-wins via
   updatedAt-tidsstämpel. localStorage är alltid den snabba lokala cachen.
   ══════════════════════════════════════════════════════════════════════════ */
function setSyncStatus(txt){
  const el = document.getElementById("syncStatus");
  if(el) el.textContent = txt;
}
function nowClock(){
  return new Date().toLocaleTimeString("sv-SE", {hour:"2-digit", minute:"2-digit"});
}
// Skicka upp hela statet till molnet.
function pushCloud(){
  if(!Store.cloudEnabled()) return;
  setSyncStatus("Synkar…");
  Store.cloudWrite({ data: S, updatedAt: S.updatedAt })
    .then(res => setSyncStatus(res && res.ok ? "Synkad "+nowClock() : "Synkfel – sparat lokalt"))
    .catch(() => setSyncStatus("Offline – sparat lokalt"));
}
// Hämta från molnet vid start / manuell synk. Nyare tidsstämpel vinner (last-write-wins).
function pullCloud(){
  if(!Store.cloudEnabled()){ setSyncStatus("Ej konfigurerad"); return; }
  setSyncStatus("Hämtar…");
  Store.cloudRead()
    .then(res => {
      if(res && res.ok && res.data && (res.updatedAt||0) > (S.updatedAt||0)){
        // Molnet är nyare → anta molnets data (spara lokalt utan att pusha tillbaka)
        S = Object.assign(freshState(), res.data);
        save({bump:false});
        reconcileStreak();
        refreshEverything();
        setSyncStatus("Synkad – hämtad "+nowClock());
      } else {
        // Lokalt är nyare eller lika → pusha upp lokalt
        pushCloud();
      }
    })
    .catch(() => setSyncStatus("Offline – kör lokalt"));
}
function syncNow(){
  if(!Store.cloudEnabled()){ setSyncStatus("Ingen URL angiven"); return; }
  pullCloud();
}
// Sparar/uppdaterar Apps Script-URL:en (från Inställningar) och synkar direkt.
function saveSyncUrl(){
  const v = (document.getElementById("setSyncUrl").value || "").trim();
  Store.saveSyncUrl(v);
  if(v){ setSyncStatus("Sparad – synkar…"); pullCloud(); }
  else  { setSyncStatus("Ej konfigurerad"); }
}
// Rendera om hela UI:t efter att data bytts ut (t.ex. hämtad från molnet)
function refreshEverything(){
  renderAll(false);
  renderAchievements();
  const g = document.getElementById("setGoal"); if(g) g.value = S.goal;
  syncMuteBtn();
  document.body.classList.toggle("reduce-motion", S.reduceMotion);
}

/* ══════════════════════════════════════════════════════════════════════════
   🔢  LEVEL-MATEMATIK
   ══════════════════════════════════════════════════════════════════════════ */
// Total XP som krävs för att HA nått level L (kumulativt)
function xpForLevel(L){
  if(L<=1) return 0;
  let sum=0;
  for(let n=1;n<L;n++) sum += Math.round(TUNE.LEVEL_BASE * Math.pow(n, TUNE.LEVEL_EXP));
  return sum;
}
function levelFromXP(xp){
  let L=1;
  while(xp >= xpForLevel(L+1)) L++;
  return L;
}
function rankForLevel(L){ return RANKS[Math.min(L-1, RANKS.length-1)]; }

/* ══════════════════════════════════════════════════════════════════════════
   🔊  LJUD  (Web Audio API – inga externa filer, funkar på file://)
   ══════════════════════════════════════════════════════════════════════════ */
let audioCtx = null;
function ac(){ if(!audioCtx){ try{ audioCtx = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} } return audioCtx; }

function beep(freqs, dur, type, gain){
  if(S.muted) return;
  const ctx = ac(); if(!ctx) return;
  if(ctx.state==="suspended") ctx.resume();
  const t0 = ctx.currentTime;
  freqs.forEach((f,i)=>{
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type||"sine"; o.frequency.value = f;
    const start = t0 + i*0.045;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain||0.16, start+0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start+dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(start); o.stop(start+dur+0.02);
  });
}
// Olika ljud för olika händelser:
function soundPop(combo){       // klick – tonhöjd stiger med combo
  const base = 440 + Math.min(combo,10)*40;
  beep([base, base*1.5], 0.16, "triangle", 0.14);
}
function soundCrit(){ beep([660,880,1320,1760], 0.28, "sawtooth", 0.13); }
function soundLevel(){ beep([523,659,784,1047,1319], 0.5, "triangle", 0.16); }
function soundAch(){ beep([784,1047,1319], 0.35, "sine", 0.14); }

/* ══════════════════════════════════════════════════════════════════════════
   🎉  KONFETTI  (canvas-confetti med Gate AI-färger)
   ══════════════════════════════════════════════════════════════════════════ */
const GATE_COLORS = ["#FFB14A","#FF4FD8","#7A3CFF","#2BB6FF","#ff007c"];
function burstConfetti(intensity, origin){
  if(S.reduceMotion) return;
  if(typeof confetti !== "function") return; // offline-fallback: hoppa
  const n = Math.round(28 + intensity*22);
  confetti({
    particleCount:n, spread: 60+intensity*10, startVelocity: 34+intensity*4,
    origin: origin||{x:.5,y:.55}, colors:GATE_COLORS, scalar:1+intensity*.12,
    ticks: 140, gravity:.9, disableForReducedMotion:false
  });
}
function bigCelebration(){
  if(S.reduceMotion || typeof confetti!=="function") return;
  const end = Date.now()+900;
  (function frame(){
    confetti({particleCount:6, angle:60, spread:75, origin:{x:0}, colors:GATE_COLORS});
    confetti({particleCount:6, angle:120, spread:75, origin:{x:1}, colors:GATE_COLORS});
    if(Date.now()<end) requestAnimationFrame(frame);
  })();
  confetti({particleCount:160, spread:110, startVelocity:45, origin:{x:.5,y:.5}, colors:GATE_COLORS, scalar:1.3});
}

/* ══════════════════════════════════════════════════════════════════════════
   🔥  COMBO-SYSTEM
   ══════════════════════════════════════════════════════════════════════════ */
let combo = 0;           // nuvarande combo-multiplikator
let lastClickTime = 0;
let comboTimer = null;
let comboBarRAF = null;

function registerCombo(){
  const now = performance.now();
  if(now - lastClickTime <= TUNE.COMBO_WINDOW){
    combo = Math.min(combo+1, TUNE.COMBO_MAX);
  } else {
    combo = 1;
  }
  lastClickTime = now;
  updateComboUI();
  startComboCountdown();
  return combo;
}
function startComboCountdown(){
  clearTimeout(comboTimer);
  comboTimer = setTimeout(()=>{ combo=0; updateComboUI(); }, TUNE.COMBO_WINDOW);
  // Animera combo-baren som en nedräkning
  cancelAnimationFrame(comboBarRAF);
  const start = performance.now();
  const bar = document.getElementById("comboBar");
  (function tick(){
    const elapsed = performance.now()-start;
    const frac = Math.max(0, 1 - elapsed/TUNE.COMBO_WINDOW);
    bar.style.transform = "scaleX("+frac+")";
    if(frac>0 && combo>0) comboBarRAF = requestAnimationFrame(tick);
  })();
}
function updateComboUI(){
  const wrap = document.getElementById("comboWrap");
  document.getElementById("comboX").textContent = "x"+Math.max(combo,1);
  wrap.classList.toggle("on", combo>=2);
}

/* ══════════════════════════════════════════════════════════════════════════
   ⭐  KÄRNLOOP – huvudklicket
   ══════════════════════════════════════════════════════════════════════════ */
const bigBtn = document.getElementById("bigBtn");
bigBtn.addEventListener("click", handleBokford);

function handleBokford(ev){
  const now = new Date();
  const day = todayKey(now);
  const mult = registerCombo();

  // Critical?
  const isCrit = Math.random() < TUNE.CRIT_CHANCE;
  let gained = TUNE.XP_PER_VERIF * mult;
  if(isCrit){ gained *= TUNE.CRIT_MULT; S.critCount++; }
  // Streak-bonus (liten extra XP om man har en pågående streak)
  if(S.streakCur > 1) gained += TUNE.STREAK_BONUS_XP;
  gained = Math.round(gained);

  // ── Uppdatera streak (dagsbaserat) ──
  updateStreakOnActivity(day);

  // ── Spara historik för UNDO (innan mutation av total/xp/level) ──
  S.history.push({
    day, xp: gained, wasCrit:isCrit,
    prevTotal:S.total, prevXP:S.xp, prevLevel:S.level, prevCrit:S.critCount-(isCrit?1:0),
    prevBest:S.bestDay, prevStreakCur:S.streakCur, prevStreakBest:S.streakBest,
    prevLastActive:S.lastActiveDay
  });
  if(S.history.length>200) S.history.shift();

  // ── Muterar state ──
  const prevLevel = S.level;
  S.total++;
  S.xp += gained;
  if(!S.byDay[day]) S.byDay[day] = {count:0, xp:0};
  S.byDay[day].count++;
  S.byDay[day].xp += gained;
  if(S.byDay[day].count > S.bestDay) S.bestDay = S.byDay[day].count;
  S.level = levelFromXP(S.xp);
  S.xpLog.push({t: now.getTime(), xp: S.xp});
  if(S.xpLog.length>2000) S.xpLog.shift();

  // "10 på 5 min"-spårning
  S.firstMinuteBurst.push(now.getTime());
  S.firstMinuteBurst = S.firstMinuteBurst.filter(t=> now.getTime()-t <= 5*60*1000);

  save();

  /* ─── VISUELLA & LJUD-EFFEKTER (allt samtidigt) ─── */
  pressAnimation();
  const btnRect = bigBtn.getBoundingClientRect();
  const ox = (btnRect.left+btnRect.width/2)/window.innerWidth;
  const oy = (btnRect.top+btnRect.height/2)/window.innerHeight;

  const intensity = Math.min(mult, TUNE.COMBO_MAX) * (isCrit?1.6:1);
  burstConfetti(intensity/2, {x:ox, y:oy});

  floatXP(gained, btnRect, isCrit, mult);

  if(isCrit){ soundCrit(); critBurst(btnRect); }
  else soundPop(mult);

  // Count-up + all UI
  animateCountUp();
  renderAll(true);

  // Level-up?
  if(S.level > prevLevel){ triggerLevelUp(S.level); }

  // Kolla achievements
  checkAchievements(now);
}

/* Press-animation + pulse-ring */
function pressAnimation(){
  bigBtn.classList.add("press");
  setTimeout(()=>bigBtn.classList.remove("press"), 130);
  if(S.reduceMotion) return;
  const ring = document.createElement("div");
  ring.className = "pulse-ring";
  ring.style.animation = "ringpop .55s ease-out forwards";
  bigBtn.appendChild(ring);
  setTimeout(()=>ring.remove(), 560);
}

/* Flytande +XP */
function floatXP(amount, rect, crit, mult){
  const el = document.createElement("div");
  el.className = "float-xp";
  el.textContent = "+"+amount+" XP" + (mult>1?"  x"+mult:"");
  el.style.left = (rect.left+rect.width/2) + "px";
  el.style.top  = (rect.top+rect.height*0.28) + "px";
  el.style.color = crit ? "#FFB14A" : "#fff";
  if(crit) el.style.fontSize = "34px";
  document.body.appendChild(el);
  setTimeout(()=>el.remove(), 1200);
}

/* CRITICAL-textburst */
function critBurst(rect){
  const el = document.createElement("div");
  el.className = "crit-burst";
  el.textContent = "CRITICAL!";
  el.style.left = (rect.left+rect.width/2) + "px";
  el.style.top  = (rect.top+rect.height*0.5) + "px";
  document.body.appendChild(el);
  burstConfetti(6, {x:(rect.left+rect.width/2)/innerWidth, y:(rect.top+rect.height/2)/innerHeight});
  setTimeout(()=>el.remove(), 1000);
}

/* ══════════════════════════════════════════════════════════════════════════
   🔥  STREAK-LOGIK
   ══════════════════════════════════════════════════════════════════════════ */
function daysBetween(a, b){ // heltal dagar mellan två "YYYY-MM-DD"
  const da = new Date(a+"T00:00:00"), db = new Date(b+"T00:00:00");
  return Math.round((db-da)/86400000);
}
function updateStreakOnActivity(day){
  if(S.lastActiveDay === day) return; // redan aktiv idag, streak oförändrad
  if(S.lastActiveDay === null){
    S.streakCur = 1;
  } else {
    const gap = daysBetween(S.lastActiveDay, day);
    if(gap === 1) S.streakCur += 1;
    else if(gap > 1) S.streakCur = 1;   // hoppade över dag(ar) → nollställ
    // gap<=0 (borde ej hända) → oförändrad
  }
  S.lastActiveDay = day;
  if(S.streakCur > S.streakBest) S.streakBest = S.streakCur;
}
// Vid sidladdning: om senaste aktiva dag är äldre än igår, är streaken bruten
function reconcileStreak(){
  if(!S.lastActiveDay){ S.streakCur = 0; return; }
  const gap = daysBetween(S.lastActiveDay, todayKey());
  if(gap >= 2) S.streakCur = 0;   // missade minst en hel dag
}

/* ══════════════════════════════════════════════════════════════════════════
   🎖️  ACHIEVEMENTS
   ══════════════════════════════════════════════════════════════════════════ */
const ACHIEVEMENTS = [
  {id:"first",   ic:"🌱", t:"Första steget",   d:"Bokför din första verifikation",   test:()=>S.total>=1},
  {id:"t10",     ic:"🔟", t:"Tio i topp",       d:"10 bokförda",                       test:()=>S.total>=10},
  {id:"t50",     ic:"5️⃣", t:"Femtio-fajter",    d:"50 bokförda",                       test:()=>S.total>=50},
  {id:"t100",    ic:"💯", t:"Hundraklubben",     d:"100 bokförda",                      test:()=>S.total>=100},
  {id:"half",    ic:"🌗", t:"Halvvägs",          d:"Halvvägs till målet",               test:()=>S.total>=S.goal/2},
  {id:"goal",    ic:"🏁", t:"Målet klart!",      d:"Nådde årets mål",                   test:()=>S.total>=S.goal},
  {id:"combo5",  ic:"⚡", t:"Combo-kung",        d:"Nå x5 combo",                       test:()=>combo>=5},
  {id:"combo10", ic:"🌀", t:"Combo-galning",     d:"Nå max combo",                      test:()=>combo>=TUNE.COMBO_MAX},
  {id:"fast10",  ic:"🚄", t:"Grinder-läge",      d:"10 på 5 minuter",                   test:()=>S.firstMinuteBurst.length>=10},
  {id:"crit",    ic:"💥", t:"Första criten",     d:"Få en CRITICAL",                    test:()=>S.critCount>=1},
  {id:"night",   ic:"🦉", t:"Nattugglan",        d:"Bokför efter kl 22:00",             test:(now)=>now && now.getHours()>=22},
  {id:"early",   ic:"🐦", t:"Tidig fågel",       d:"Bokför före kl 08:00",              test:(now)=>now && now.getHours()<8},
  {id:"s3",      ic:"🔥", t:"3-dagars streak",   d:"Aktiv 3 dagar i rad",               test:()=>S.streakCur>=3},
  {id:"s7",      ic:"🔥", t:"7-dagars streak",   d:"Aktiv 7 dagar i rad",               test:()=>S.streakCur>=7},
  {id:"s14",     ic:"🔥", t:"14-dagars streak",  d:"Aktiv 14 dagar i rad",              test:()=>S.streakCur>=14},
  {id:"record",  ic:"📈", t:"Nytt dagsrekord",   d:"Slå ditt bästa dagsantal (>1)",     test:()=>S.bestDay>1 && S.byDay[todayKey()] && S.byDay[todayKey()].count===S.bestDay},
  {id:"lvl5",    ic:"🎖️", t:"Level 5",           d:"Nå level 5",                        test:()=>S.level>=5},
  {id:"lvl10",   ic:"👑", t:"Level 10",          d:"Nå level 10",                       test:()=>S.level>=10},
  {id:"god",     ic:"🪐", t:"Bokföringsgud",     d:"Nå level 13",                       test:()=>S.level>=13},
];

function checkAchievements(now){
  ACHIEVEMENTS.forEach(a=>{
    if(!S.achievements[a.id] && a.test(now)){
      S.achievements[a.id] = true;
      save();
      showToast(a.ic, "Achievement!", a.t + " – " + a.d);
      soundAch();
      renderAchievements();
    }
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   🍞  TOASTS
   ══════════════════════════════════════════════════════════════════════════ */
function showToast(ic, title, desc){
  const zone = document.getElementById("toastZone");
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = '<div class="tic">'+ic+'</div><div><div class="tt">'+title+'</div><div class="td">'+desc+'</div></div>';
  zone.appendChild(el);
  setTimeout(()=>{ el.classList.add("out"); setTimeout(()=>el.remove(),400); }, 3200);
}

/* ══════════════════════════════════════════════════════════════════════════
   🎊  LEVEL UP
   ══════════════════════════════════════════════════════════════════════════ */
function triggerLevelUp(newLevel){
  const lu = document.getElementById("levelup");
  document.getElementById("luLevel").textContent = "Level " + newLevel;
  document.getElementById("luRank").textContent = rankForLevel(newLevel);
  lu.classList.add("show");
  bigCelebration();
  soundLevel();
  const close = ()=>{ lu.classList.remove("show"); lu.removeEventListener("click",close); };
  setTimeout(()=> lu.addEventListener("click", close), 250);
  setTimeout(close, 4000); // auto-stäng
}

/* ══════════════════════════════════════════════════════════════════════════
   🔢  COUNT-UP-ANIMATION (huvudräknarna)
   ══════════════════════════════════════════════════════════════════════════ */
function countUp(el, to, dur){
  const from = parseInt(el.dataset.v||"0",10);
  if(from===to){ el.textContent = to; return; }
  if(S.reduceMotion){ el.textContent = to; el.dataset.v = to; return; }
  const start = performance.now();
  dur = dur||500;
  (function step(t){
    const p = Math.min(1,(t-start)/dur);
    const eased = 1-Math.pow(1-p,3);
    el.textContent = Math.round(from + (to-from)*eased);
    if(p<1) requestAnimationFrame(step); else { el.textContent=to; el.dataset.v=to; }
  })(start);
}
function animateCountUp(){
  countUp(document.getElementById("bigTotal"), S.total);
  countUp(document.getElementById("totalXP"), S.xp);
}

/* ══════════════════════════════════════════════════════════════════════════
   📊  CHART.JS – diagram
   ══════════════════════════════════════════════════════════════════════════ */
let chDaily, chBurnup, chXP;
const GRID_COLOR = "rgba(255,255,255,.06)";
const TICK_COLOR = "#9a97b8";

function makeGrad(ctx, area){
  if(!area) return "#FF4FD8";
  const g = ctx.createLinearGradient(0, area.bottom, 0, area.top);
  g.addColorStop(0,"#2BB6FF"); g.addColorStop(.4,"#7A3CFF");
  g.addColorStop(.7,"#FF4FD8"); g.addColorStop(1,"#FFB14A");
  return g;
}

function lastNDays(n){
  const arr=[]; const now=new Date();
  for(let i=n-1;i>=0;i--){ const d=new Date(now); d.setDate(now.getDate()-i); arr.push(todayKey(d)); }
  return arr;
}
function shortLabel(key){ const p=key.split("-"); return p[2]+"/"+p[1]; }

function initCharts(){
  if(typeof Chart === "undefined") return; // offline: hoppa över diagram
  Chart.defaults.font.family = "'Space Grotesk', sans-serif";
  Chart.defaults.color = TICK_COLOR;

  const days = lastNDays(30);
  const dailyData = days.map(k=> S.byDay[k]? S.byDay[k].count : 0);

  chDaily = new Chart(document.getElementById("chartDaily"), {
    type:"bar",
    data:{ labels:days.map(shortLabel), datasets:[{
      data:dailyData, borderRadius:6, borderSkipped:false,
      backgroundColor:(c)=>makeGrad(c.chart.ctx, c.chart.chartArea), maxBarThickness:26
    }]},
    options:chartOpts({stepInt:true})
  });

  // Burnup: kumulativ summa mot mål
  let cum=0; const cumData = days.map(k=>{ cum += S.byDay[k]?S.byDay[k].count:0; return cum; });
  // Justera startvärde så äldre historik utanför fönstret räknas med
  const before = S.total - dailyData.reduce((a,b)=>a+b,0);
  const cumAdj = cumData.map(v=> v+before);
  chBurnup = new Chart(document.getElementById("chartBurnup"), {
    type:"line",
    data:{ labels:days.map(shortLabel), datasets:[
      { label:"Bokförda", data:cumAdj, borderColor:"#FF4FD8", borderWidth:3,
        fill:true, tension:.35, pointRadius:0,
        backgroundColor:(c)=>{ const g=makeGrad(c.chart.ctx,c.chart.chartArea);
          const area=c.chart.chartArea; if(!area) return "transparent";
          const gr=c.chart.ctx.createLinearGradient(0,area.top,0,area.bottom);
          gr.addColorStop(0,"rgba(255,79,216,.35)"); gr.addColorStop(1,"rgba(255,79,216,0)"); return gr; } },
      { label:"Mål", data:days.map(()=>S.goal), borderColor:"rgba(255,255,255,.35)",
        borderDash:[6,6], borderWidth:2, pointRadius:0, fill:false }
    ]},
    options:chartOpts({legend:true})
  });

  // XP över tid – bygg dagliga XP-snapshots
  const xpByDay = days.map(k=> S.byDay[k]? S.byDay[k].xp : 0);
  let xc=0; const xpCum = xpByDay.map(v=>{ xc+=v; return xc; });
  const xpBefore = S.xp - xpByDay.reduce((a,b)=>a+b,0);
  const xpCumAdj = xpCum.map(v=> v+xpBefore);
  chXP = new Chart(document.getElementById("chartXP"), {
    type:"line",
    data:{ labels:days.map(shortLabel), datasets:[{
      data:xpCumAdj, borderColor:"#2BB6FF", borderWidth:3, tension:.35, pointRadius:0, fill:true,
      backgroundColor:(c)=>{ const area=c.chart.chartArea; if(!area) return "transparent";
        const gr=c.chart.ctx.createLinearGradient(0,area.top,0,area.bottom);
        gr.addColorStop(0,"rgba(43,182,255,.35)"); gr.addColorStop(1,"rgba(122,60,255,0)"); return gr; }
    }]},
    options:chartOpts({})
  });
}

function chartOpts(o){
  return {
    responsive:true, maintainAspectRatio:false,
    animation:{ duration: S.reduceMotion?0:800, easing:"easeOutQuart" },
    plugins:{ legend:{ display:!!o.legend, labels:{boxWidth:12, font:{size:11}} }, tooltip:{
      backgroundColor:"rgba(20,18,32,.95)", borderColor:"rgba(255,79,216,.4)", borderWidth:1,
      padding:10, cornerRadius:10 } },
    scales:{
      x:{ grid:{color:GRID_COLOR, drawBorder:false}, ticks:{maxRotation:0, autoSkip:true, maxTicksLimit:10, font:{size:10}} },
      y:{ grid:{color:GRID_COLOR, drawBorder:false}, beginAtZero:true,
          ticks:{ precision:0, font:{size:10} } }
    }
  };
}

function refreshCharts(){
  if(typeof Chart === "undefined") return;
  const days = lastNDays(30);
  const dailyData = days.map(k=> S.byDay[k]? S.byDay[k].count : 0);
  const before = S.total - dailyData.reduce((a,b)=>a+b,0);
  let cum=before; const cumAdj = days.map(k=>{ cum += S.byDay[k]?S.byDay[k].count:0; return cum; });
  const xpByDay = days.map(k=> S.byDay[k]? S.byDay[k].xp : 0);
  const xpBefore = S.xp - xpByDay.reduce((a,b)=>a+b,0);
  let xc=xpBefore; const xpCumAdj = days.map(k=>{ xc += S.byDay[k]?S.byDay[k].xp:0; return xc; });

  if(chDaily){ chDaily.data.datasets[0].data = dailyData; chDaily.update(); }
  if(chBurnup){ chBurnup.data.datasets[0].data = cumAdj;
    chBurnup.data.datasets[1].data = days.map(()=>S.goal); chBurnup.update(); }
  if(chXP){ chXP.data.datasets[0].data = xpCumAdj; chXP.update(); }
}

/* ══════════════════════════════════════════════════════════════════════════
   🖼️  RENDER (all UI utom count-up)
   ══════════════════════════════════════════════════════════════════════════ */
function renderAll(fromClick){
  const today = todayKey();
  const todayCount = S.byDay[today]? S.byDay[today].count : 0;

  // Progress-ring
  const pct = S.goal>0 ? Math.min(100, (S.total/S.goal)*100) : 0;
  const C = 2*Math.PI*100; // omkrets
  document.getElementById("ringProg").style.strokeDashoffset = C*(1-pct/100);
  document.getElementById("ringPct").textContent = Math.round(pct)+"%";
  document.getElementById("ringFrac").textContent = S.total+" / "+S.goal;
  document.getElementById("ringLeft").textContent = Math.max(0,S.goal-S.total)+" kvar";

  // Level & XP
  const L = S.level;
  const curFloor = xpForLevel(L), nextFloor = xpForLevel(L+1);
  const into = S.xp-curFloor, need = nextFloor-curFloor;
  document.getElementById("rankName").textContent = rankForLevel(L);
  document.getElementById("levelLine").textContent = "Level "+L;
  document.getElementById("xpFill").style.width = Math.min(100,(into/need)*100)+"%";
  document.getElementById("xpCur").textContent = into+" XP";
  document.getElementById("xpNeed").textContent = need+" XP till Lv "+(L+1);
  document.getElementById("critCount").textContent = S.critCount;

  // Streak
  document.getElementById("streakCur").textContent = S.streakCur+" "+(S.streakCur===1?"dag":"dagar");
  document.getElementById("streakBest").textContent = S.streakBest;

  // Totalt / idag / bästa
  document.getElementById("todayCount").textContent = todayCount;
  document.getElementById("bestDay").textContent = S.bestDay;
  document.getElementById("statToday").textContent = todayCount;
  document.getElementById("statBest").textContent = S.bestDay;
  document.getElementById("statDays").textContent = Object.keys(S.byDay).length;

  // Undo-knapp
  document.getElementById("undoBtn").style.opacity = S.history.length? "1":".4";

  if(!fromClick){
    document.getElementById("bigTotal").textContent = S.total; document.getElementById("bigTotal").dataset.v=S.total;
    document.getElementById("totalXP").textContent = S.xp; document.getElementById("totalXP").dataset.v=S.xp;
  }

  renderHeatmap();
  refreshCharts();
  renderCarousel();
}

/* Heatmap: senaste ~18 veckor */
function renderHeatmap(){
  const holder = document.getElementById("heatmap");
  holder.innerHTML="";
  const WEEKS = 18;
  const now = new Date();
  // Starta på måndag WEEKS veckor tillbaka
  const start = new Date(now); start.setDate(now.getDate() - (WEEKS*7));
  // Justera till närmaste måndag bakåt
  const dow = (start.getDay()+6)%7; start.setDate(start.getDate()-dow);
  const tk = todayKey();
  let maxCount=1; for(const k in S.byDay) maxCount=Math.max(maxCount, S.byDay[k].count);

  for(let w=0; w<=WEEKS; w++){
    for(let d=0; d<7; d++){
      const cell = document.createElement("div");
      cell.className="hm-cell";
      const day = new Date(start); day.setDate(start.getDate()+w*7+d);
      if(day>now){ cell.style.visibility="hidden"; holder.appendChild(cell); continue; }
      const key = todayKey(day);
      const cnt = S.byDay[key]? S.byDay[key].count : 0;
      if(cnt>0){
        const ratio = cnt/maxCount;
        cell.dataset.l = ratio>0.66?"3":ratio>0.33?"2":"1";
      }
      if(key===tk) cell.classList.add("today");
      cell.title = key+": "+cnt+" verifikationer";
      holder.appendChild(cell);
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   🎠  FRAMSTEGS-CAROUSEL – förhandsvisar övriga segment, roterar automatiskt
   ══════════════════════════════════════════════════════════════════════════ */
const CAR_ROTATE_MS = 10000;                              // Byt vy var 10:e sekund (trimbart)
const CAR_SLIDES = ["burnup","daily","xp","streak","ach"]; // Ordning på förhandsvisningarna
let carIndex = 0, carTimer = null;

/* Lätta inline-SVG-sparklines (ingen extra Chart.js – snabbt & snyggt) */
function sparkBars(vals,w,h){
  const max=Math.max(1,...vals), n=vals.length, bw=w/n; let r="";
  for(let i=0;i<n;i++){ const bh=Math.max(2,(vals[i]/max)*(h-3));
    r+=`<rect x="${(i*bw+bw*0.18).toFixed(1)}" y="${(h-bh).toFixed(1)}" width="${(bw*0.64).toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="url(#sparkGrad)"/>`; }
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:${h}px">${r}</svg>`;
}
function sparkLine(vals,w,h){
  const max=Math.max(...vals,1), min=Math.min(...vals,0), n=vals.length, span=(max-min)||1;
  const pts=vals.map((v,i)=>[(n===1?w:i/(n-1)*w), h-2-((v-min)/span)*(h-4)]);
  const line=pts.map(p=>`${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:${h}px">
    <polygon points="0,${h} ${line} ${w},${h}" fill="rgba(255,79,216,.14)"/>
    <polyline points="${line}" fill="none" stroke="url(#sparkLineGrad)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function miniHeatmapHTML(weeks){
  const now=new Date(); const start=new Date(now); start.setDate(now.getDate()-weeks*7);
  const dow=(start.getDay()+6)%7; start.setDate(start.getDate()-dow);
  let max=1; for(const k in S.byDay) max=Math.max(max,S.byDay[k].count);
  const tk=todayKey(); let cells="";
  for(let w=0;w<=weeks;w++) for(let d=0;d<7;d++){
    const day=new Date(start); day.setDate(start.getDate()+w*7+d);
    if(day>now){ cells+='<i style="visibility:hidden"></i>'; continue; }
    const key=todayKey(day); const cnt=S.byDay[key]?S.byDay[key].count:0;
    let l=""; if(cnt>0){ const rt=cnt/max; l=rt>0.66?"3":rt>0.33?"2":"1"; }
    cells+=`<i${l?` data-l="${l}"`:""}${key===tk?' class="today"':""}></i>`;
  }
  return `<div class="mini-heat">${cells}</div>`;
}
/* Bygger HTML för en förhandsvisnings-slide */
function carSlideHTML(id){
  const d30=lastNDays(30), d14=lastNDays(14);
  const tkey=todayKey(); const todayCount=S.byDay[tkey]?S.byDay[tkey].count:0;
  if(id==="streak"){
    return `<div class="car-title">🔥 Streak</div>
      <div class="car-body">
      <div class="car-row"><span class="car-flame">🔥</span>
        <div><div class="car-big">${S.streakCur} ${S.streakCur===1?"dag":"dagar"}</div>
        <div class="car-sub">Längsta: <b>${S.streakBest}</b> dagar</div></div></div>
      ${miniHeatmapHTML(10)}</div>`;
  }
  if(id==="daily"){
    const vals=d14.map(k=>S.byDay[k]?S.byDay[k].count:0);
    return `<div class="car-title">📅 Verifikationer / dag</div>
      <div class="car-body">
      <div class="car-spark">${sparkBars(vals,150,66)}</div>
      <div class="car-sub">Senaste 14 dagarna · Idag <b>${todayCount}</b></div></div>`;
  }
  if(id==="burnup"){
    const pct=S.goal>0?Math.min(100,Math.round(S.total/S.goal*100)):0;
    let c=S.total-d30.map(k=>S.byDay[k]?S.byDay[k].count:0).reduce((a,b)=>a+b,0);
    const cum=d30.map(k=>{ c+=S.byDay[k]?S.byDay[k].count:0; return c; });
    return `<div class="car-title">🚀 Mot målet</div>
      <div class="car-body">
      <div class="car-big grad">${pct}%</div>
      <div class="car-sub">${S.total} / ${S.goal} · <b>${Math.max(0,S.goal-S.total)}</b> kvar</div>
      <div class="car-spark">${sparkLine(cum,150,52)}</div></div>`;
  }
  if(id==="xp"){
    let x=S.xp-d30.map(k=>S.byDay[k]?S.byDay[k].xp:0).reduce((a,b)=>a+b,0);
    const cum=d30.map(k=>{ x+=S.byDay[k]?S.byDay[k].xp:0; return x; });
    return `<div class="car-title">✨ XP-trend</div>
      <div class="car-body">
      <div class="car-spark">${sparkLine(cum,150,66)}</div>
      <div class="car-sub">Total <b>${S.xp} XP</b> · Level ${S.level}</div></div>`;
  }
  if(id==="ach"){
    const total=ACHIEVEMENTS.length, un=ACHIEVEMENTS.filter(a=>S.achievements[a.id]).length;
    const icons=ACHIEVEMENTS.slice(0,10).map(a=>`<span class="car-ach${S.achievements[a.id]?" on":""}">${S.achievements[a.id]?a.ic:"🔒"}</span>`).join("");
    return `<div class="car-title">🎖️ Achievements</div>
      <div class="car-body">
      <div class="car-big grad">${un} / ${total}</div>
      <div class="car-sub">upplåsta</div>
      <div class="car-ach-row">${icons}</div></div>`;
  }
  return "";
}
function buildCarousel(){
  const host=document.getElementById("carSlides"); if(!host) return;
  host.innerHTML=""; const dots=document.getElementById("carDots"); dots.innerHTML="";
  CAR_SLIDES.forEach((id,i)=>{
    const s=document.createElement("div"); s.className="car-slide"+(i===0?" active":""); s.dataset.slide=id; host.appendChild(s);
    const b=document.createElement("button"); b.className="car-dot"+(i===0?" on":""); b.onclick=()=>goCarousel(i,true); dots.appendChild(b);
  });
  carIndex=0;
}
function renderCarousel(){
  document.querySelectorAll("#carSlides .car-slide").forEach(s=>{ s.innerHTML=carSlideHTML(s.dataset.slide); });
}
function goCarousel(i,manual){
  const slides=document.querySelectorAll("#carSlides .car-slide"); if(!slides.length) return;
  carIndex=(i+CAR_SLIDES.length)%CAR_SLIDES.length;
  slides.forEach((s,idx)=>s.classList.toggle("active",idx===carIndex));
  document.querySelectorAll("#carDots .car-dot").forEach((d,idx)=>d.classList.toggle("on",idx===carIndex));
  if(manual) restartCarousel();
}
function restartCarousel(){ clearInterval(carTimer); carTimer=setInterval(()=>goCarousel(carIndex+1), CAR_ROTATE_MS); }
function startCarousel(){
  const el=document.getElementById("carousel"); if(!el) return;
  restartCarousel();
  el.addEventListener("mouseenter",()=>clearInterval(carTimer));   // pausa vid hover
  el.addEventListener("mouseleave",restartCarousel);
}

function renderAchievements(){
  const grid = document.getElementById("achGrid");
  grid.innerHTML="";
  ACHIEVEMENTS.forEach(a=>{
    const un = !!S.achievements[a.id];
    const el = document.createElement("div");
    el.className = "ach "+(un?"unlocked":"locked");
    el.innerHTML = '<div class="ic">'+(un?a.ic:"🔒")+'</div><div class="t">'+a.t+'</div><div class="d">'+a.d+'</div>';
    grid.appendChild(el);
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   ↩️  UNDO
   ══════════════════════════════════════════════════════════════════════════ */
function undoLast(){
  if(!S.history.length){ showToast("🤷","Inget att ångra","Historiken är tom"); return; }
  const h = S.history.pop();
  // Återställ dag-data
  if(S.byDay[h.day]){
    S.byDay[h.day].count = Math.max(0, S.byDay[h.day].count-1);
    S.byDay[h.day].xp = Math.max(0, S.byDay[h.day].xp - h.xp);
    if(S.byDay[h.day].count===0) delete S.byDay[h.day];
  }
  S.total = h.prevTotal; S.xp = h.prevXP; S.level = h.prevLevel;
  S.critCount = h.prevCrit; S.bestDay = h.prevBest;
  S.streakCur = h.prevStreakCur; S.streakBest = h.prevStreakBest; S.lastActiveDay = h.prevLastActive;
  if(S.xpLog.length) S.xpLog.pop();
  save();
  combo=0; updateComboUI();
  renderAll(false);
  showToast("↩️","Ångrat","Senaste bokföring borttagen");
}

/* ══════════════════════════════════════════════════════════════════════════
   ⚙️  INSTÄLLNINGAR / EXPORT / IMPORT / RESET
   ══════════════════════════════════════════════════════════════════════════ */
function openSettings(){
  document.getElementById("setGoal").value = S.goal;
  document.getElementById("setSound").checked = !S.muted;
  document.getElementById("setReduce").checked = S.reduceMotion;
  document.getElementById("setSyncUrl").value = Store.syncUrl;
  setSyncStatus(Store.syncUrl ? "Konfigurerad" : "Ej konfigurerad");
  document.getElementById("settingsBg").classList.add("show");
}
function closeSettings(){ document.getElementById("settingsBg").classList.remove("show"); }

function openTips(){ document.getElementById("tipsBg").classList.add("show"); }
function closeTips(){ document.getElementById("tipsBg").classList.remove("show"); }

document.getElementById("setGoal").addEventListener("change", e=>{
  const v = parseInt(e.target.value,10);
  if(v>0){ S.goal=v; save(); renderAll(false); checkAchievements(new Date()); }
});
document.getElementById("setSound").addEventListener("change", e=>{ S.muted=!e.target.checked; save(); syncMuteBtn(); });
document.getElementById("setReduce").addEventListener("change", e=>{
  S.reduceMotion=e.target.checked; save(); document.body.classList.toggle("reduce-motion", S.reduceMotion);
});
document.getElementById("setSyncUrl").addEventListener("change", saveSyncUrl);

function toggleMute(){ S.muted=!S.muted; save(); syncMuteBtn();
  const c=document.getElementById("setSound"); if(c) c.checked=!S.muted; }
function syncMuteBtn(){
  const b=document.getElementById("muteBtn");
  b.textContent = S.muted? "🔇 Ljud av" : "🔊 Ljud";
  b.classList.toggle("active", !S.muted);
}

function exportData(){
  const blob = new Blob([JSON.stringify(S,null,2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "verif-grinder-backup-"+todayKey()+".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
  showToast("⬇️","Exporterat","Backup nedladdad");
}

document.getElementById("importFile").addEventListener("change", e=>{
  const file = e.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = ev=>{
    try{
      const data = JSON.parse(ev.target.result);
      if(typeof data.total !== "number") throw new Error("Ogiltig fil");
      if(!confirm("Detta ersätter din nuvarande data med importens ("+data.total+" bokförda). Fortsätt?")) return;
      S = Object.assign(freshState(), data);
      save();
      location.reload();
    }catch(err){ alert("Kunde inte importera: "+err.message); }
  };
  reader.readAsText(file);
  e.target.value="";
});

function hardReset(){
  if(!confirm("Är du säker? Detta raderar ALL din grind-data permanent (den riktiga bokföringen i Spiris påverkas inte).")) return;
  if(!confirm("Helt säker? Detta går inte att ångra. Exportera en backup först om du är osäker.")) return;
  localStorage.removeItem(Store.localKey());
  location.reload();
}

/* ══════════════════════════════════════════════════════════════════════════
   🚀  INIT
   ══════════════════════════════════════════════════════════════════════════ */
function init(){
  reconcileStreak();
  save({bump:false});          // vid start: spara ev. streak-justering utan att stämpla ny tid
  document.body.classList.toggle("reduce-motion", S.reduceMotion);
  syncMuteBtn();
  initCharts();
  buildCarousel();
  renderAll(false);
  renderAchievements();
  startCarousel();
  // Tangentbord: mellanslag / Enter = bokför (bekvämt för snabb grind)
  window.addEventListener("keydown", e=>{
    const anyModalOpen = document.getElementById("settingsBg").classList.contains("show")
                      || document.getElementById("tipsBg").classList.contains("show");
    if((e.code==="Space"||e.code==="Enter") && !anyModalOpen){
      const tag=(e.target.tagName||"").toLowerCase();
      if(tag==="input"||tag==="textarea") return;
      e.preventDefault(); bigBtn.click();
    }
  });
  // Stäng modal vid klick på bakgrund
  document.getElementById("settingsBg").addEventListener("click", e=>{
    if(e.target.id==="settingsBg") closeSettings();
  });
  document.getElementById("tipsBg").addEventListener("click", e=>{
    if(e.target.id==="tipsBg") closeTips();
  });
  // Molnsynk: läs ev. sparad Apps Script-URL och hämta från molnet vid start
  Store.loadSyncUrl();
  if(Store.cloudEnabled()) pullCloud();
}
init();
