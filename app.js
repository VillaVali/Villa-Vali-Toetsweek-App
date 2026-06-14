const DATA = window.JAMES_DATA;
const SUBJECTS = DATA.subjects;
const STORAGE_KEY = "james-toetsweek-v2";
const LEGACY_KEY = "james-command-center-v1";

const BADGES = [
  { id: "kickoff", mark: "01", name: "Kick-off", text: "Geef je eerste goede antwoord.", check: (s) => s.totalCorrect >= 1 },
  { id: "wk-break", mark: "10", name: "WK-pauze", text: "Geef 10 goede antwoorden.", check: (s) => s.totalCorrect >= 10 },
  { id: "level-up", mark: "25", name: "Level Up", text: "Geef 25 goede antwoorden.", check: (s) => s.totalCorrect >= 25 },
  { id: "test-ready", mark: "80", name: "Toetsklaar", text: "Haal minimaal 80% in een toets.", check: (s) => s.quizHistory.some((x) => x.percent >= 80) },
  { id: "comeback", mark: "R", name: "Comeback", text: "Maak een fout kaartje later goed.", check: (s) => s.recoveredCards >= 1 },
  { id: "focus", mark: "25M", name: "Focusspeler", text: "Rond een focusblok af.", check: (s) => s.focusSessions >= 1 },
  { id: "streak", mark: "3D", name: "Vaste basis", text: "Leer drie dagen achter elkaar.", check: (s) => s.streak >= 3 },
  { id: "allround", mark: "2V", name: "Allrounder", text: "Geef goede antwoorden bij beide vakken.", check: (s) => s.subjectStats.biologie.correct > 0 && s.subjectStats.frans.correct > 0 },
];

const DEFAULT_STATE = {
  version: 2,
  xp: 0,
  totalCorrect: 0,
  totalWrong: 0,
  streak: 0,
  lastStudyDate: "",
  studyDates: [],
  reviewCards: [],
  reviewQuestions: [],
  cardStats: {},
  questionStats: {},
  subjectStats: {
    biologie: { correct: 0, wrong: 0 },
    frans: { correct: 0, wrong: 0 },
  },
  quizHistory: [],
  fatherSessions: 0,
  focusSessions: 0,
  recoveredCards: 0,
  badges: {},
  focusTimer: { mode: "study", remaining: 1500, running: false, endAt: null },
};

let state = loadState();
let flashSession = null;
let quizSession = null;
let fatherSession = null;
let quickTimer = { remaining: 900, running: false, endAt: null };
let timerInterval = null;
let quickInterval = null;
let deferredInstall = null;
let toastTimer = null;
let touchStartX = null;

const main = document.querySelector("#main-content");
const headerXP = document.querySelector("#header-xp");
const headerStreak = document.querySelector("#header-streak");
const toast = document.querySelector("#toast");
const celebration = document.querySelector("#celebration");
const installDialog = document.querySelector("#install-dialog");
const resetDialog = document.querySelector("#reset-dialog");
const confirmInstall = document.querySelector("#confirm-install");

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) {
      const merged = { ...cloneDefault(), ...saved };
      merged.subjectStats = { ...cloneDefault().subjectStats, ...(saved.subjectStats || {}) };
      merged.focusTimer = { ...cloneDefault().focusTimer, ...(saved.focusTimer || {}) };
      return merged;
    }

    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY));
    if (legacy) {
      const migrated = cloneDefault();
      migrated.xp = Number(legacy.xp || 0);
      migrated.streak = Number(legacy.streak || 0);
      migrated.lastStudyDate = legacy.lastVisit || "";
      migrated.quizHistory = Array.isArray(legacy.quizHistory) ? legacy.quizHistory : [];
      migrated.fatherSessions = Number(legacy.fatherSessions || 0);
      return migrated;
    }
  } catch {
    // A fresh state is safer than blocking the app on damaged local data.
  }
  return cloneDefault();
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  updateHeader();
}

function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function touchStudyDay() {
  const today = todayKey();
  if (state.lastStudyDate === today) return;

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  state.streak = state.lastStudyDate === todayKey(yesterday) ? state.streak + 1 : 1;
  state.lastStudyDate = today;
  if (!state.studyDates.includes(today)) state.studyDates.push(today);
  state.studyDates = state.studyDates.slice(-60);
}

function getLevel() {
  return Math.floor(state.totalCorrect / 25) + 1;
}

function updateHeader() {
  headerXP.textContent = state.xp;
  headerStreak.textContent = state.streak;
}

function subjectStyle(subject) {
  return `--accent:${subject.accent}`;
}

function difficultyLabel(value) {
  return { easy: "Easy", medium: "Medium", hard: "Hard" }[value] || value;
}

function normalizeAnswer(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function gradeOpen(question, rawAnswer) {
  const answer = normalizeAnswer(rawAnswer);
  if (!answer) return false;

  const accepted = (question.acceptedAnswers || [question.correctAnswer]).map(normalizeAnswer);
  if (accepted.some((item) => answer === item || (item.length > 5 && answer.includes(item)))) return true;

  if (question.requiredKeywords) {
    const uniqueKeywords = [...new Set(question.requiredKeywords.map(normalizeAnswer))];
    return uniqueKeywords.every((keyword) => answer.includes(keyword));
  }

  if (question.requiredAny) {
    const matches = [...new Set(question.requiredAny.map(normalizeAnswer))].filter((keyword) => answer.includes(keyword));
    return matches.length >= (question.minimumMatches || 1);
  }

  return false;
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
  }
  return result;
}

function uniquePush(list, id) {
  if (!list.includes(id)) list.push(id);
}

function removeFrom(list, id) {
  const index = list.indexOf(id);
  if (index >= 0) list.splice(index, 1);
}

function registerResult({ correct, subjectId, itemType, itemId, xp = 10 }) {
  touchStudyDay();
  const beforeCorrect = state.totalCorrect;
  const previousLevel = Math.floor(beforeCorrect / 25) + 1;
  const wasReviewCard = itemType === "card" && state.reviewCards.includes(itemId);

  if (!state.subjectStats[subjectId]) state.subjectStats[subjectId] = { correct: 0, wrong: 0 };

  if (correct) {
    state.totalCorrect += 1;
    state.subjectStats[subjectId].correct += 1;
    state.xp += xp;

    if (itemType === "card") {
      state.cardStats[itemId] = {
        ...(state.cardStats[itemId] || {}),
        good: (state.cardStats[itemId]?.good || 0) + 1,
      };
      removeFrom(state.reviewCards, itemId);
      if (wasReviewCard) state.recoveredCards += 1;
    } else {
      state.questionStats[itemId] = {
        ...(state.questionStats[itemId] || {}),
        good: (state.questionStats[itemId]?.good || 0) + 1,
      };
      removeFrom(state.reviewQuestions, itemId);
    }
  } else {
    state.totalWrong += 1;
    state.subjectStats[subjectId].wrong += 1;

    if (itemType === "card") {
      state.cardStats[itemId] = {
        ...(state.cardStats[itemId] || {}),
        wrong: (state.cardStats[itemId]?.wrong || 0) + 1,
      };
      uniquePush(state.reviewCards, itemId);
    } else {
      state.questionStats[itemId] = {
        ...(state.questionStats[itemId] || {}),
        wrong: (state.questionStats[itemId]?.wrong || 0) + 1,
      };
      uniquePush(state.reviewQuestions, itemId);
    }
  }

  const newLevel = getLevel();
  const earnedBreak = correct && Math.floor(state.totalCorrect / 10) > Math.floor(beforeCorrect / 10);
  const leveledUp = correct && newLevel > previousLevel;
  const newBadges = unlockBadges();
  saveState();

  if (correct) showToast(`Goed! +${xp} XP`);
  if (earnedBreak) {
    setTimeout(() => {
      showToast("WK-pauze verdiend na 10 goede antwoorden");
      burstCelebration();
    }, 500);
  }
  if (leveledUp) {
    setTimeout(() => {
      showToast(`Level Up! Je bent nu level ${newLevel}`);
      burstCelebration();
    }, 1100);
  } else if (newBadges.length) {
    setTimeout(() => showToast(`Badge: ${newBadges[0]}`), 800);
  }
}

function unlockBadges() {
  const newBadges = [];
  BADGES.forEach((badge) => {
    if (!state.badges[badge.id] && badge.check(state)) {
      state.badges[badge.id] = new Date().toISOString();
      newBadges.push(badge.name);
    }
  });
  return newBadges;
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function burstCelebration() {
  const colors = ["#35c987", "#ffffff", "#5da9e9", "#f0c451"];
  celebration.innerHTML = Array.from({ length: 36 }, (_, index) => {
    const left = Math.round(Math.random() * 100);
    const drift = `${Math.round(Math.random() * 150 - 75)}px`;
    const delay = `${Math.random() * 0.4}s`;
    return `<i style="left:${left}%;--drift:${drift};animation-delay:${delay};background:${colors[index % colors.length]}"></i>`;
  }).join("");
  setTimeout(() => (celebration.innerHTML = ""), 2000);
}

function parseRoute() {
  const raw = (location.hash || "#/home").slice(1);
  const [path, query = ""] = raw.split("?");
  return { parts: path.split("/").filter(Boolean), params: new URLSearchParams(query) };
}

function routeName(page) {
  if (["subject", "flashcards", "quiz", "father", "quick"].includes(page)) return "subjects";
  return page;
}

function getReviewCount(subjectId) {
  const subject = SUBJECTS[subjectId];
  if (!subject) return 0;
  const cardIds = new Set(subject.flashcards.map((card) => card.id));
  const questionIds = new Set(subject.questions.map((question) => question.id));
  return state.reviewCards.filter((id) => cardIds.has(id)).length + state.reviewQuestions.filter((id) => questionIds.has(id)).length;
}

function getAccuracy(subjectId) {
  const stats = state.subjectStats[subjectId] || { correct: 0, wrong: 0 };
  const attempts = stats.correct + stats.wrong;
  return attempts ? Math.round((stats.correct / attempts) * 100) : 0;
}

function getMasteredCount(subjectId) {
  return SUBJECTS[subjectId].flashcards.filter((card) => (state.cardStats[card.id]?.good || 0) > 0).length;
}

function getQuestionById(id) {
  for (const subject of Object.values(SUBJECTS)) {
    const question = subject.questions.find((item) => item.id === id);
    if (question) return { question, subject };
  }
  return null;
}

function getCardById(id) {
  for (const subject of Object.values(SUBJECTS)) {
    const card = subject.flashcards.find((item) => item.id === id);
    if (card) return { card, subject };
  }
  return null;
}

function updateNav(page) {
  document.querySelectorAll("[data-nav]").forEach((link) => {
    link.classList.toggle("active", link.dataset.nav === routeName(page));
  });
}

function render() {
  clearTransientIntervals();
  const route = parseRoute();
  const [page = "home", id] = route.parts;
  updateNav(page);

  if (page === "home") renderHome();
  else if (page === "subjects") renderSubjects();
  else if (page === "subject") renderSubject(id);
  else if (page === "flashcards") renderFlashcards(route.params);
  else if (page === "quiz") renderQuiz(route.params);
  else if (page === "father") renderFather(route.params);
  else if (page === "quick") renderQuick(route.params);
  else if (page === "focus") renderFocus();
  else if (page === "progress") renderProgress();
  else renderNotFound();

  window.scrollTo({ top: 0, behavior: "instant" });
}

function clearTransientIntervals() {
  clearInterval(quickInterval);
  quickInterval = null;
  clearInterval(timerInterval);
  timerInterval = null;
}

function renderHome() {
  const reviewTotal = state.reviewCards.length + state.reviewQuestions.length;
  const activeSubjects = Object.values(SUBJECTS).filter((subject) => subject.enabled);
  const recommended = activeSubjects.sort((a, b) => getAccuracy(a.id) - getAccuracy(b.id))[0];
  const greeting = new Date().getHours() < 12 ? "Goedemorgen" : new Date().getHours() < 18 ? "Goedemiddag" : "Goedenavond";

  main.innerHTML = `
    <div class="page">
      <section class="coach-hero">
        <div class="hero-topline">
          <span class="kicker">${greeting}, James</span>
          <span class="level-chip">Level ${getLevel()}</span>
        </div>
        <h1>Vandaag beter dan gisteren.</h1>
        <p>Jouw coachadvies: ${reviewTotal ? `pak eerst ${reviewTotal} lastig${reviewTotal === 1 ? "" : "e"} item${reviewTotal === 1 ? "" : "s"} terug.` : `bouw een korte ronde ${recommended.name} op.`}</p>
        <a class="button button-lime button-wide" href="#/focus">Start Focusblok</a>
        <div class="hero-score">
          <span><b>${state.totalCorrect}</b> goede antwoorden</span>
          <span><b>${Math.floor(state.totalCorrect / 10)}</b> WK-pauzes</span>
        </div>
      </section>

      <section class="section">
        <div class="section-heading">
          <div><span class="kicker">Coachplan</span><h2>Vandaag leren</h2></div>
        </div>
        <div class="today-grid">
          <a class="action-card action-card-primary" href="#/subject/${recommended.id}">
            <span class="card-icon">${recommended.short}</span>
            <span><b>Ga verder met ${recommended.name}</b><small>${recommended.subtitle}</small></span>
            <span class="chevron">›</span>
          </a>
          <a class="action-card" href="#/quick">
            <span class="card-icon">15</span>
            <span><b>Laatste 15 minuten voor de toets</b><small>Alleen de kern, geen omwegen</small></span>
            <span class="chevron">›</span>
          </a>
          <a class="action-card ${reviewTotal ? "" : "muted"}" href="${reviewTotal ? `#/flashcards?subject=${recommended.id}&review=1` : `#/flashcards?subject=${recommended.id}`}">
            <span class="card-icon">R</span>
            <span><b>Nog oefenen</b><small>${reviewTotal} openstaand · fouten komen hier terug</small></span>
            <span class="chevron">›</span>
          </a>
        </div>
      </section>

      <section class="section">
        <div class="section-heading">
          <div><span class="kicker">Stand van zaken</span><h2>Voortgang per vak</h2></div>
          <a href="#/subjects">Alle vakken</a>
        </div>
        <div class="progress-list">
          ${activeSubjects.map(renderSubjectProgress).join("")}
        </div>
      </section>

      <section class="section">
        <div class="section-heading"><div><span class="kicker">Wedstrijdschema</span><h2>Toetsweek planning</h2></div></div>
        <div class="schedule">
          ${DATA.schedule.map(({ day, subjectId }) => {
            const subject = SUBJECTS[subjectId];
            return `
              <a class="schedule-row" href="#/subject/${subject.id}">
                <span class="schedule-day">${day.slice(0, 2).toUpperCase()}</span>
                <span class="subject-badge" style="${subjectStyle(subject)}">${subject.short}</span>
                <span><b>${subject.name}</b><small>${subject.subtitle}</small></span>
                <span class="status-dot ${subject.enabled ? "ready" : ""}" title="${subject.enabled ? "Interactief" : "Klaar om uit te breiden"}"></span>
              </a>
            `;
          }).join("")}
        </div>
      </section>
    </div>
  `;
}

function renderSubjectProgress(subject) {
  const accuracy = getAccuracy(subject.id);
  const review = getReviewCount(subject.id);
  const mastered = getMasteredCount(subject.id);
  return `
    <a class="subject-progress" href="#/subject/${subject.id}" style="${subjectStyle(subject)}">
      <span class="subject-badge">${subject.short}</span>
      <span class="progress-copy">
        <span><b>${subject.name}</b><small>${review} nog oefenen</small></span>
        <span class="track"><i style="width:${accuracy}%"></i></span>
      </span>
      <span class="progress-value">${accuracy || mastered ? `${accuracy}%` : "Start"}</span>
    </a>
  `;
}

function renderSubjects() {
  main.innerHTML = `
    <div class="page">
      <header class="page-title">
        <span class="kicker">Teamselectie</span>
        <h1>Kies je vak</h1>
        <p>Frans en Biologie zijn compleet. De andere vakken zijn als uitbreidbare basis klaargezet.</p>
      </header>
      <div class="subject-grid">
        ${Object.values(SUBJECTS).map((subject) => `
          <a class="subject-tile ${subject.enabled ? "" : "coming"}" href="#/subject/${subject.id}" style="${subjectStyle(subject)}">
            <span class="subject-badge">${subject.short}</span>
            <span class="tile-status">${subject.enabled ? `${subject.questions.length} vragen` : "Basis klaar"}</span>
            <h2>${subject.name}</h2>
            <p>${subject.subtitle}</p>
            ${subject.enabled ? `<span class="tile-score">${getAccuracy(subject.id)}% nauwkeurig · ${getReviewCount(subject.id)} oefenen</span>` : `<span class="tile-score">Later eenvoudig uit te breiden</span>`}
          </a>
        `).join("")}
      </div>
    </div>
  `;
}

function renderSubject(subjectId) {
  const subject = SUBJECTS[subjectId];
  if (!subject) return renderNotFound();
  const reviewCards = state.reviewCards.filter((id) => subject.flashcards.some((card) => card.id === id)).length;
  const reviewQuestions = state.reviewQuestions.filter((id) => subject.questions.some((question) => question.id === id)).length;

  main.innerHTML = `
    <div class="page" style="${subjectStyle(subject)}">
      <a class="back-link" href="#/subjects">‹ Alle vakken</a>
      <section class="subject-hero">
        <span class="subject-badge large">${subject.short}</span>
        <div>
          <span class="kicker">${subject.examDay}</span>
          <h1>${subject.name}</h1>
          <p>${subject.subtitle}</p>
        </div>
        ${subject.enabled ? `<span class="accuracy-ring"><b>${getAccuracy(subject.id)}%</b><small>score</small></span>` : ""}
      </section>

      ${subject.enabled ? `
        <section class="section">
          <div class="mode-grid">
            <a class="mode-card" href="#/flashcards?subject=${subject.id}">
              <span class="mode-icon">FC</span><b>Flashcards</b><small>${subject.flashcards.length} kaarten · swipe of knoppen</small>
            </a>
            <a class="mode-card" href="#/quiz?subject=${subject.id}&count=10">
              <span class="mode-icon">10</span><b>Korte toets</b><small>10 gemixte vragen</small>
            </a>
            <a class="mode-card" href="#/quiz?subject=${subject.id}&count=30">
              <span class="mode-icon">30</span><b>Volledige toets</b><small>Alle 30 vragen</small>
            </a>
            <a class="mode-card dark" href="#/father?subject=${subject.id}">
              <span class="mode-icon">V</span><b>Vader-overhoor</b><small>Rustig samen oefenen</small>
            </a>
            <a class="mode-card quick" href="#/quick?subject=${subject.id}">
              <span class="mode-icon">15</span><b>Laatste 15 minuten</b><small>Alleen de kernpunten</small>
            </a>
            <a class="mode-card review ${reviewCards + reviewQuestions ? "" : "muted"}" href="#/flashcards?subject=${subject.id}&review=1">
              <span class="mode-icon">R</span><b>Nog oefenen</b><small>${reviewCards} kaarten · ${reviewQuestions} vragen</small>
            </a>
          </div>
        </section>
      ` : `
        <section class="section"><div class="coach-note"><b>Uitbreidbaar vak</b><p>De samenvatting staat klaar. Voeg later kaartjes en vragen toe in <code>data.js</code>; de leerstanden verschijnen dan automatisch.</p></div></section>
      `}

      <section class="section">
        <div class="section-heading"><div><span class="kicker">Spelplan</span><h2>Samenvatting</h2></div></div>
        <div class="topic-list">
          ${subject.topics.map((topic, index) => `
            <details class="topic-card" ${index === 0 ? "open" : ""}>
              <summary><span>${String(index + 1).padStart(2, "0")}</span><b>${topic.title}</b><i>+</i></summary>
              <div class="topic-content">
                <p>${topic.summary}</p>
                <ul>${topic.points.map((point) => `<li>${point}</li>`).join("")}</ul>
              </div>
            </details>
          `).join("")}
        </div>
      </section>
    </div>
  `;
}

function makeFlashSession(subject, reviewOnly) {
  let cards = subject.flashcards;
  if (reviewOnly) {
    cards = state.reviewCards.map(getCardById).filter((result) => result?.subject.id === subject.id).map((result) => result.card);
  }
  return {
    subjectId: subject.id,
    reviewOnly,
    cards: reviewOnly ? cards : shuffle(cards),
    index: 0,
    revealed: false,
    good: 0,
    wrong: 0,
  };
}

function renderFlashcards(params) {
  const subject = SUBJECTS[params.get("subject")];
  const reviewOnly = params.get("review") === "1";
  if (!subject?.enabled) return renderModePicker("flashcards", "Flashcards", "Kies een vak om kaartjes te trainen.");
  if (!flashSession || flashSession.subjectId !== subject.id || flashSession.reviewOnly !== reviewOnly) {
    flashSession = makeFlashSession(subject, reviewOnly);
  }

  if (!flashSession.cards.length) {
    main.innerHTML = `
      <div class="page"><a class="back-link" href="#/subject/${subject.id}">‹ ${subject.name}</a>
        <section class="result-card">
          <span class="result-mark">0</span><span class="kicker">Nog oefenen</span>
          <h1>Je wachtrij is leeg</h1><p>Mooi. Start een gewone ronde; kaarten die fout gaan komen hier automatisch terug.</p>
          <a class="button button-wide" href="#/flashcards?subject=${subject.id}">Start alle flashcards</a>
        </section>
      </div>`;
    return;
  }

  if (flashSession.index >= flashSession.cards.length) {
    const remaining = state.reviewCards.filter((id) => subject.flashcards.some((card) => card.id === id)).length;
    main.innerHTML = `
      <div class="page"><a class="back-link" href="#/subject/${subject.id}">‹ ${subject.name}</a>
        <section class="result-card">
          <span class="result-mark">${flashSession.good}</span><span class="kicker">Ronde klaar</span>
          <h1>${flashSession.good} goed, ${flashSession.wrong} fout</h1>
          <p>${remaining ? `${remaining} kaart${remaining === 1 ? "" : "en"} staan klaar in Nog oefenen.` : "Alles uit deze ronde is weggewerkt."}</p>
          <div class="button-stack">
            ${remaining ? `<a class="button button-lime" href="#/flashcards?subject=${subject.id}&review=1">Train Nog oefenen</a>` : ""}
            <button class="button button-ghost" data-action="restart-flashcards">Nieuwe ronde</button>
          </div>
        </section>
      </div>`;
    return;
  }

  const card = flashSession.cards[flashSession.index];
  const progress = Math.round(((flashSession.index + 1) / flashSession.cards.length) * 100);
  main.innerHTML = `
    <div class="page session-page" style="${subjectStyle(subject)}">
      <div class="session-header">
        <a class="back-link" href="#/subject/${subject.id}">‹ Stoppen</a>
        <span>${reviewOnly ? "Nog oefenen" : "Flashcards"} · ${flashSession.index + 1}/${flashSession.cards.length}</span>
      </div>
      <div class="track session-track"><i style="width:${progress}%"></i></div>
      <div class="card-meta"><span class="difficulty ${card.difficulty}">${difficultyLabel(card.difficulty)}</span><span>Swipe links/rechts of gebruik de knoppen</span></div>
      <section class="flash-stage" aria-live="polite">
        <span class="kicker">${subject.name} · ${subject.topics.find((topic) => topic.id === card.topicId)?.title || ""}</span>
        <h1>${card.front}</h1>
        ${flashSession.revealed ? `<div class="flash-answer"><span>Antwoord</span><b>${card.back}</b></div>` : `<button class="button button-lime" data-action="reveal-card">Toon antwoord</button>`}
      </section>
      ${flashSession.revealed ? `
        <div class="rating-row">
          <button class="button button-wrong" data-action="rate-card" data-correct="false">Fout</button>
          <button class="button button-correct" data-action="rate-card" data-correct="true">Goed</button>
        </div>
      ` : ""}
      <div class="previous-next">
        <button class="button button-ghost" data-action="previous-card" ${flashSession.index === 0 ? "disabled" : ""}>Vorige</button>
        <button class="button button-ghost" data-action="next-card">Volgende</button>
      </div>
    </div>
  `;
}

function createQuizSession(subject, count, reviewOnly) {
  let source = reviewOnly
    ? state.reviewQuestions.map(getQuestionById).filter((result) => result?.subject.id === subject.id).map((result) => result.question)
    : subject.questions;

  if (!source.length) source = subject.questions;
  let questions;
  if (count >= source.length) {
    questions = shuffle(source);
  } else {
    const open = shuffle(source.filter((question) => question.type === "open"));
    const multipleChoice = shuffle(source.filter((question) => question.type === "mc"));
    const openCount = Math.min(Math.floor(count / 2), open.length);
    questions = shuffle([...open.slice(0, openCount), ...multipleChoice.slice(0, count - openCount)]);
  }

  return {
    subjectId: subject.id,
    count,
    reviewOnly,
    questions,
    index: 0,
    correct: 0,
    wrong: 0,
    answered: false,
    selected: null,
    isCorrect: false,
    saved: false,
  };
}

function renderQuiz(params) {
  const subject = SUBJECTS[params.get("subject")];
  const count = Math.min(Number(params.get("count") || 10), 30);
  const reviewOnly = params.get("review") === "1";
  if (!subject?.enabled) return renderModePicker("quiz", "Toetsmodus", "Kies een vak en krijg direct feedback.");
  if (!quizSession || quizSession.subjectId !== subject.id || quizSession.count !== count || quizSession.reviewOnly !== reviewOnly) {
    quizSession = createQuizSession(subject, count, reviewOnly);
  }

  if (quizSession.index >= quizSession.questions.length) {
    const percent = quizSession.questions.length ? Math.round((quizSession.correct / quizSession.questions.length) * 100) : 0;
    const advice = percent >= 80 ? "Toetsklaar" : "Nog oefenen";
    if (!quizSession.saved) {
      state.quizHistory.push({ subjectId: subject.id, percent, correct: quizSession.correct, total: quizSession.questions.length, date: new Date().toISOString() });
      state.quizHistory = state.quizHistory.slice(-30);
      if (percent >= 80) state.xp += 25;
      unlockBadges();
      saveState();
      quizSession.saved = true;
      if (percent >= 80) burstCelebration();
    }
    main.innerHTML = `
      <div class="page"><a class="back-link" href="#/subject/${subject.id}">‹ ${subject.name}</a>
        <section class="result-card">
          <span class="score-ring ${percent >= 80 ? "ready" : ""}"><b>${percent}%</b><small>${advice}</small></span>
          <span class="kicker">Eindscore</span>
          <h1>${quizSession.correct} van ${quizSession.questions.length} goed</h1>
          <p>${percent >= 80 ? "Sterk. Je kunt deze stof onder toetsdruk terughalen." : "Pak je fouten terug in Nog oefenen en probeer daarna opnieuw."}</p>
          <div class="result-stats"><span><b>${quizSession.correct}</b> goed</span><span><b>${quizSession.wrong}</b> fout</span></div>
          <div class="button-stack">
            ${percent < 80 ? `<a class="button button-lime" href="#/quiz?subject=${subject.id}&review=1&count=10">Oefen foute vragen</a>` : ""}
            <button class="button button-ghost" data-action="restart-quiz">Toets opnieuw</button>
          </div>
        </section>
      </div>`;
    return;
  }

  const question = quizSession.questions[quizSession.index];
  const progress = Math.round(((quizSession.index + 1) / quizSession.questions.length) * 100);
  main.innerHTML = `
    <div class="page session-page" style="${subjectStyle(subject)}">
      <div class="session-header"><a class="back-link" href="#/subject/${subject.id}">‹ Stoppen</a><span>${quizSession.index + 1}/${quizSession.questions.length}</span></div>
      <div class="track session-track"><i style="width:${progress}%"></i></div>
      <section class="question-card">
        <div class="question-meta">
          <span class="difficulty ${question.difficulty}">${difficultyLabel(question.difficulty)}</span>
          <span>${question.type === "mc" ? "Meerkeuze" : "Open vraag"}</span>
        </div>
        <h1>${question.prompt}</h1>
        ${question.type === "mc" ? renderMultipleChoice(question) : renderOpenQuestion(question)}
        ${quizSession.answered ? renderQuestionFeedback(question) : ""}
      </section>
      ${quizSession.answered ? `<button class="button button-lime button-wide" data-action="next-question">${quizSession.index + 1 === quizSession.questions.length ? "Bekijk eindscore" : "Volgende vraag"}</button>` : ""}
    </div>
  `;
}

function renderMultipleChoice(question) {
  return `<div class="answer-list">${question.options.map((option, index) => {
    let className = "";
    if (quizSession.answered && index === question.correctAnswer) className = "correct";
    else if (quizSession.answered && index === quizSession.selected) className = "wrong";
    return `<button class="answer-option ${className}" data-action="answer-mc" data-index="${index}" ${quizSession.answered ? "disabled" : ""}><span>${String.fromCharCode(65 + index)}</span>${option}</button>`;
  }).join("")}</div>`;
}

function renderOpenQuestion() {
  if (quizSession.answered) {
    return `<div class="submitted-answer"><span>Jouw antwoord</span><b>${quizSession.selected || "Geen antwoord"}</b></div>`;
  }
  return `
    <form class="open-answer-form" data-open-answer>
      <label for="open-answer">Jouw antwoord</label>
      <input id="open-answer" name="answer" autocomplete="off" autocapitalize="sentences" required placeholder="Typ je antwoord..." />
      <button class="button button-lime" type="submit">Controleer antwoord</button>
    </form>
  `;
}

function renderQuestionFeedback(question) {
  const correctText = question.type === "mc" ? question.options[question.correctAnswer] : question.correctAnswer;
  return `
    <div class="feedback ${quizSession.isCorrect ? "correct" : "wrong"}">
      <b>${quizSession.isCorrect ? "Goed antwoord." : "Nog niet goed."}</b>
      ${!quizSession.isCorrect ? `<span>Juiste antwoord: ${correctText}</span>` : ""}
      <p>${question.explanation}</p>
    </div>
  `;
}

function renderFather(params) {
  const subject = SUBJECTS[params.get("subject")];
  if (!subject?.enabled) return renderModePicker("father", "Vader-overhoor", "Kies een vak voor een rustige random vragenronde.");
  if (!fatherSession || fatherSession.subjectId !== subject.id) {
    fatherSession = {
      subjectId: subject.id,
      questions: shuffle(subject.questions).slice(0, 12),
      index: 0,
      correct: 0,
      wrong: 0,
      revealed: false,
      saved: false,
    };
  }

  if (fatherSession.index >= fatherSession.questions.length) {
    if (!fatherSession.saved) {
      state.fatherSessions += 1;
      state.xp += 15;
      saveState();
      fatherSession.saved = true;
    }
    const percent = Math.round((fatherSession.correct / fatherSession.questions.length) * 100);
    main.innerHTML = `
      <div class="page father-page"><a class="back-link light" href="#/subject/${subject.id}">‹ ${subject.name}</a>
        <section class="father-result">
          <span class="result-mark">${percent}%</span><span class="kicker">Overhoorronde klaar</span>
          <h1>${fatherSession.correct} goed · ${fatherSession.wrong} fout</h1>
          <p>De foute vragen staan nu bij Nog oefenen.</p>
          <div class="button-stack"><button class="button button-lime" data-action="restart-father">Nieuwe random ronde</button><a class="button button-dark-ghost" href="#/subject/${subject.id}">Klaar</a></div>
        </section>
      </div>`;
    return;
  }

  const question = fatherSession.questions[fatherSession.index];
  const answer = question.type === "mc" ? question.options[question.correctAnswer] : question.correctAnswer;
  main.innerHTML = `
    <div class="page father-page">
      <div class="father-topbar">
        <a class="back-link light" href="#/subject/${subject.id}">‹ Stoppen</a>
        <span>Score <b>${fatherSession.correct}</b> goed · <b>${fatherSession.wrong}</b> fout</span>
      </div>
      <div class="father-progress">${fatherSession.index + 1} / ${fatherSession.questions.length}</div>
      <section class="father-question">
        <span class="kicker">Vader leest voor · ${difficultyLabel(question.difficulty)}</span>
        <h1>${question.prompt}</h1>
        ${fatherSession.revealed ? `<div class="father-answer"><span>Antwoord</span><b>${answer}</b><p>${question.explanation}</p></div>` : `<button class="button button-lime" data-action="reveal-father">Toon antwoord</button>`}
      </section>
      ${fatherSession.revealed ? `<div class="rating-row"><button class="button button-dark-wrong" data-action="rate-father" data-correct="false">Fout</button><button class="button button-lime" data-action="rate-father" data-correct="true">Goed</button></div>` : ""}
    </div>
  `;
}

function renderQuick(params) {
  const requested = params.get("subject");
  const subjects = requested && SUBJECTS[requested]?.enabled
    ? [SUBJECTS[requested]]
    : Object.values(SUBJECTS).filter((subject) => subject.enabled);
  const minutes = Math.floor(quickTimer.remaining / 60);
  const seconds = quickTimer.remaining % 60;

  main.innerHTML = `
    <div class="page quick-page">
      <a class="back-link" href="${requested ? `#/subject/${requested}` : "#/home"}">‹ Terug</a>
      <section class="quick-hero">
        <span class="kicker">Geen paniek. Alleen de kern.</span>
        <h1>Laatste 15 minuten voor de toets</h1>
        <div class="quick-clock">${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}</div>
        <button class="button button-lime" data-action="toggle-quick">${quickTimer.running ? "Pauzeer timer" : quickTimer.remaining < 900 ? "Ga verder" : "Start 15 minuten"}</button>
      </section>
      ${subjects.map((subject) => `
        <section class="section" style="${subjectStyle(subject)}">
          <div class="section-heading"><div><span class="kicker">${subject.short}</span><h2>${subject.name}: dit moet zitten</h2></div></div>
          <div class="quick-topics">
            ${subject.quickTopicIds.map((topicId) => {
              const topic = subject.topics.find((item) => item.id === topicId);
              return `<article class="quick-topic"><h3>${topic.title}</h3><p>${topic.summary}</p><ul>${topic.points.map((point) => `<li>${point}</li>`).join("")}</ul></article>`;
            }).join("")}
          </div>
          <a class="button button-wide" href="#/quiz?subject=${subject.id}&count=10">Doe 10 controlevragen</a>
        </section>
      `).join("")}
    </div>
  `;
  if (quickTimer.running) startQuickInterval(requested);
}

function renderFocus() {
  syncFocusTimer();
  const timer = state.focusTimer;
  const total = timer.mode === "study" ? 1500 : 300;
  const progress = Math.max(0, Math.min(100, ((total - timer.remaining) / total) * 100));
  const minutes = Math.floor(timer.remaining / 60);
  const seconds = timer.remaining % 60;

  main.innerHTML = `
    <div class="page focus-page">
      <header class="page-title">
        <span class="kicker">Focusblok</span>
        <h1>${timer.mode === "study" ? "25 minuten leren" : "5 minuten pauze"}</h1>
        <p>${timer.mode === "study" ? "Telefoon stil. Eén vak. Eén duidelijk doel." : "Pauze verdiend. Sta op, drink wat en kijk even weg."}</p>
      </header>
      <section class="timer-card ${timer.mode}">
        <div class="timer-ring" style="--timer-progress:${progress * 3.6}deg">
          <div><span>${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}</span><small>${timer.mode === "study" ? "FOCUS" : "PAUZE"}</small></div>
        </div>
        <div class="timer-actions">
          <button class="button button-lime" data-action="toggle-focus">${timer.running ? "Pauzeer" : timer.remaining < total ? "Ga verder" : "Start timer"}</button>
          <button class="button button-dark-ghost" data-action="reset-focus">Reset</button>
        </div>
      </section>
      <section class="section">
        <div class="focus-tips">
          <span><b>1</b>Kies Frans of Biologie</span>
          <span><b>2</b>Werk zonder meldingen</span>
          <span><b>3</b>Na 25 minuten volgt je pauze</span>
        </div>
      </section>
    </div>
  `;
  if (timer.running) startFocusInterval();
}

function syncFocusTimer() {
  const timer = state.focusTimer;
  if (!timer.running || !timer.endAt) return;
  timer.remaining = Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000));
  if (timer.remaining === 0) completeFocusPhase();
}

function completeFocusPhase() {
  const timer = state.focusTimer;
  if (timer.mode === "study") {
    timer.mode = "break";
    timer.remaining = 300;
    timer.running = false;
    timer.endAt = null;
    state.focusSessions += 1;
    state.xp += 30;
    touchStudyDay();
    unlockBadges();
    saveState();
    showToast("Focusblok klaar. Pauze verdiend!");
    burstCelebration();
    if (navigator.vibrate && navigator.userActivation?.hasBeenActive) {
      navigator.vibrate([150, 80, 150]);
    }
  } else {
    timer.mode = "study";
    timer.remaining = 1500;
    timer.running = false;
    timer.endAt = null;
    saveState();
    showToast("Pauze klaar. Je bent weer fris.");
  }
}

function startFocusInterval() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    syncFocusTimer();
    const clock = document.querySelector(".timer-ring span");
    if (!clock) return clearInterval(timerInterval);
    const timer = state.focusTimer;
    clock.textContent = `${String(Math.floor(timer.remaining / 60)).padStart(2, "0")}:${String(timer.remaining % 60).padStart(2, "0")}`;
    if (!timer.running) {
      clearInterval(timerInterval);
      renderFocus();
    }
  }, 500);
}

function startQuickInterval(requestedSubject) {
  clearInterval(quickInterval);
  quickInterval = setInterval(() => {
    quickTimer.remaining = Math.max(0, Math.ceil((quickTimer.endAt - Date.now()) / 1000));
    const clock = document.querySelector(".quick-clock");
    if (!clock) return clearInterval(quickInterval);
    clock.textContent = `${String(Math.floor(quickTimer.remaining / 60)).padStart(2, "0")}:${String(quickTimer.remaining % 60).padStart(2, "0")}`;
    if (quickTimer.remaining === 0) {
      quickTimer.running = false;
      clearInterval(quickInterval);
      showToast("15 minuten klaar. Adem uit: je hebt de kern herhaald.");
      burstCelebration();
      renderQuick(new URLSearchParams(requestedSubject ? `subject=${requestedSubject}` : ""));
    }
  }, 500);
}

function renderProgress() {
  const levelProgress = state.totalCorrect % 25;
  const bestScore = state.quizHistory.length ? Math.max(...state.quizHistory.map((item) => item.percent)) : 0;
  const reviewTotal = state.reviewCards.length + state.reviewQuestions.length;

  main.innerHTML = `
    <div class="page">
      <header class="page-title"><span class="kicker">Scorebord</span><h1>Jouw groei</h1><p>Niet perfect hoeven zijn. Wel je fouten terugpakken.</p></header>
      <section class="level-panel">
        <div><span class="kicker">Level ${getLevel()}</span><h2>${state.xp} XP</h2><p>${25 - levelProgress} goede antwoorden tot level ${getLevel() + 1}</p></div>
        <div class="level-number">${getLevel()}</div>
        <span class="track"><i style="width:${(levelProgress / 25) * 100}%"></i></span>
      </section>
      <section class="section">
        <div class="stats-grid">
          <article><b>${state.totalCorrect}</b><span>goede antwoorden</span></article>
          <article><b>${state.totalWrong}</b><span>foute antwoorden</span></article>
          <article><b>${reviewTotal}</b><span>nog oefenen</span></article>
          <article><b>${bestScore}%</b><span>beste toets</span></article>
          <article><b>${state.streak}</b><span>dagen streak</span></article>
          <article><b>${Math.floor(state.totalCorrect / 10)}</b><span>WK-pauzes</span></article>
        </div>
      </section>
      <section class="section">
        <div class="section-heading"><div><span class="kicker">Mijlpalen</span><h2>Badges</h2></div><span>${Object.keys(state.badges).length}/${BADGES.length}</span></div>
        <div class="badge-grid">
          ${BADGES.map((badge) => `
            <article class="badge-card ${state.badges[badge.id] ? "unlocked" : "locked"}">
              <span>${badge.mark}</span><b>${badge.name}</b><small>${state.badges[badge.id] ? "Verdiend" : badge.text}</small>
            </article>
          `).join("")}
        </div>
      </section>
      <section class="section settings-card">
        <h2>App op je telefoon</h2>
        <p>Installeer de PWA voor een app-icoon en offline gebruik.</p>
        <button class="button button-ghost" data-action="open-install">Installatiehulp</button>
        <button class="text-button danger" data-action="open-reset">Wis alle voortgang</button>
      </section>
    </div>
  `;
}

function renderModePicker(mode, title, description) {
  const active = Object.values(SUBJECTS).filter((subject) => subject.enabled);
  main.innerHTML = `
    <div class="page">
      <header class="page-title"><span class="kicker">Kies een vak</span><h1>${title}</h1><p>${description}</p></header>
      <div class="subject-grid">
        ${active.map((subject) => `<a class="subject-tile" href="#/${mode}?subject=${subject.id}" style="${subjectStyle(subject)}"><span class="subject-badge">${subject.short}</span><h2>${subject.name}</h2><p>${subject.subtitle}</p></a>`).join("")}
      </div>
    </div>
  `;
}

function renderNotFound() {
  main.innerHTML = `<div class="page"><section class="result-card"><span class="result-mark">?</span><h1>Pagina niet gevonden</h1><p>Ga terug naar je dashboard.</p><a class="button" href="#/home">Naar Vandaag</a></section></div>`;
}

function answerQuestion(selected, isCorrect) {
  if (quizSession.answered) return;
  const question = quizSession.questions[quizSession.index];
  quizSession.answered = true;
  quizSession.selected = selected;
  quizSession.isCorrect = isCorrect;
  if (isCorrect) quizSession.correct += 1;
  else quizSession.wrong += 1;
  registerResult({ correct: isCorrect, subjectId: quizSession.subjectId, itemType: "question", itemId: question.id, xp: 10 });
  renderQuiz(new URLSearchParams(`subject=${quizSession.subjectId}&count=${quizSession.count}${quizSession.reviewOnly ? "&review=1" : ""}`));
}

main.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;

  if (action === "reveal-card") {
    flashSession.revealed = true;
    renderFlashcards(new URLSearchParams(`subject=${flashSession.subjectId}${flashSession.reviewOnly ? "&review=1" : ""}`));
  } else if (action === "rate-card") {
    const correct = target.dataset.correct === "true";
    const card = flashSession.cards[flashSession.index];
    if (correct) flashSession.good += 1;
    else flashSession.wrong += 1;
    registerResult({ correct, subjectId: flashSession.subjectId, itemType: "card", itemId: card.id, xp: 5 });
    flashSession.index += 1;
    flashSession.revealed = false;
    renderFlashcards(new URLSearchParams(`subject=${flashSession.subjectId}${flashSession.reviewOnly ? "&review=1" : ""}`));
  } else if (action === "previous-card") {
    flashSession.index = Math.max(0, flashSession.index - 1);
    flashSession.revealed = false;
    renderFlashcards(new URLSearchParams(`subject=${flashSession.subjectId}${flashSession.reviewOnly ? "&review=1" : ""}`));
  } else if (action === "next-card") {
    flashSession.index += 1;
    flashSession.revealed = false;
    renderFlashcards(new URLSearchParams(`subject=${flashSession.subjectId}${flashSession.reviewOnly ? "&review=1" : ""}`));
  } else if (action === "restart-flashcards") {
    const subjectId = flashSession.subjectId;
    const review = flashSession.reviewOnly;
    flashSession = null;
    renderFlashcards(new URLSearchParams(`subject=${subjectId}${review ? "&review=1" : ""}`));
  } else if (action === "answer-mc") {
    const question = quizSession.questions[quizSession.index];
    const selected = Number(target.dataset.index);
    answerQuestion(selected, selected === question.correctAnswer);
  } else if (action === "next-question") {
    quizSession.index += 1;
    quizSession.answered = false;
    quizSession.selected = null;
    renderQuiz(new URLSearchParams(`subject=${quizSession.subjectId}&count=${quizSession.count}${quizSession.reviewOnly ? "&review=1" : ""}`));
  } else if (action === "restart-quiz") {
    const subjectId = quizSession.subjectId;
    const count = quizSession.count;
    const review = quizSession.reviewOnly;
    quizSession = null;
    renderQuiz(new URLSearchParams(`subject=${subjectId}&count=${count}${review ? "&review=1" : ""}`));
  } else if (action === "reveal-father") {
    fatherSession.revealed = true;
    renderFather(new URLSearchParams(`subject=${fatherSession.subjectId}`));
  } else if (action === "rate-father") {
    const correct = target.dataset.correct === "true";
    const question = fatherSession.questions[fatherSession.index];
    if (correct) fatherSession.correct += 1;
    else fatherSession.wrong += 1;
    registerResult({ correct, subjectId: fatherSession.subjectId, itemType: "question", itemId: question.id, xp: 8 });
    fatherSession.index += 1;
    fatherSession.revealed = false;
    renderFather(new URLSearchParams(`subject=${fatherSession.subjectId}`));
  } else if (action === "restart-father") {
    const subjectId = fatherSession.subjectId;
    fatherSession = null;
    renderFather(new URLSearchParams(`subject=${subjectId}`));
  } else if (action === "toggle-quick") {
    if (quickTimer.running) {
      quickTimer.remaining = Math.max(0, Math.ceil((quickTimer.endAt - Date.now()) / 1000));
      quickTimer.running = false;
      quickTimer.endAt = null;
    } else {
      if (quickTimer.remaining <= 0) quickTimer.remaining = 900;
      quickTimer.running = true;
      quickTimer.endAt = Date.now() + quickTimer.remaining * 1000;
    }
    renderQuick(parseRoute().params);
  } else if (action === "toggle-focus") {
    const timer = state.focusTimer;
    if (timer.running) {
      timer.remaining = Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000));
      timer.running = false;
      timer.endAt = null;
    } else {
      timer.running = true;
      timer.endAt = Date.now() + timer.remaining * 1000;
    }
    saveState();
    renderFocus();
  } else if (action === "reset-focus") {
    const mode = state.focusTimer.mode;
    state.focusTimer = { mode, remaining: mode === "study" ? 1500 : 300, running: false, endAt: null };
    saveState();
    renderFocus();
  } else if (action === "open-install") {
    updateInstallHelp();
    installDialog.showModal();
  } else if (action === "open-reset") {
    resetDialog.showModal();
  }
});

main.addEventListener("submit", (event) => {
  if (!event.target.matches("[data-open-answer]")) return;
  event.preventDefault();
  const question = quizSession.questions[quizSession.index];
  const answer = new FormData(event.target).get("answer");
  answerQuestion(String(answer), gradeOpen(question, answer));
});

main.addEventListener("touchstart", (event) => {
  if (!event.target.closest(".flash-stage")) return;
  touchStartX = event.changedTouches[0].clientX;
}, { passive: true });

main.addEventListener("touchend", (event) => {
  if (touchStartX === null || !event.target.closest(".flash-stage")) return;
  const delta = event.changedTouches[0].clientX - touchStartX;
  touchStartX = null;
  if (Math.abs(delta) < 55 || !flashSession) return;
  if (delta < 0) flashSession.index += 1;
  else flashSession.index = Math.max(0, flashSession.index - 1);
  flashSession.revealed = false;
  renderFlashcards(new URLSearchParams(`subject=${flashSession.subjectId}${flashSession.reviewOnly ? "&review=1" : ""}`));
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});

document.querySelector("#confirm-reset").addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  state = cloneDefault();
  flashSession = null;
  quizSession = null;
  fatherSession = null;
  saveState();
  resetDialog.close();
  showToast("Alle voortgang is gewist");
  render();
});

function updateInstallHelp() {
  const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (isStandalone) {
    document.querySelector("#install-help").textContent = "De app is al geïnstalleerd op dit apparaat.";
  } else if (deferredInstall) {
    document.querySelector("#install-help").textContent = "Tik op Installeer app. Daarna staat James Toetsweek tussen je apps.";
    confirmInstall.hidden = false;
  } else if (isiOS) {
    document.querySelector("#install-help").textContent = "Open in Safari, tik op Delen en kies 'Zet op beginscherm'.";
    confirmInstall.hidden = true;
  } else {
    document.querySelector("#install-help").textContent = "Open het browsermenu en kies 'App installeren' of 'Toevoegen aan startscherm'.";
    confirmInstall.hidden = true;
  }
}

confirmInstall.addEventListener("click", async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  confirmInstall.hidden = true;
  installDialog.close();
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstall = event;
});

window.addEventListener("hashchange", render);
window.addEventListener("visibilitychange", () => {
  if (!document.hidden && location.hash.startsWith("#/focus")) renderFocus();
});

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}

unlockBadges();
saveState();
render();
