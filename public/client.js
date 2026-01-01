const socket = io();

const joinCard = document.getElementById('joinCard');
const buzzCard = document.getElementById('buzzCard');
const joinBtn = document.getElementById('joinBtn');
const teamNameInput = document.getElementById('teamName');
const joinError = document.getElementById('joinError');
const teamLabel = document.getElementById('teamLabel');
const teamNameDisplay = document.getElementById('teamNameDisplay');
const statusLine = document.getElementById('statusLine');
const buzzBtn = document.getElementById('buzzBtn');
const roundLabel = document.getElementById('roundLabel');
const scoreLine = document.getElementById('scoreLine');
const reactionLine = document.getElementById('reactionLine');
const pointsLine = document.getElementById('pointsLine');
const timesLine = document.getElementById('timesLine');
const missesLine = document.getElementById('missesLine');
const timerLine = document.getElementById('timerLine');
const lockoutLine = document.getElementById('lockoutLine');
const connDot = document.getElementById('connDot');
const connText = document.getElementById('connText');

const STORAGE_ID = 'gtm_team_id';
const STORAGE_NAME = 'gtm_team_name';

let teamId = localStorage.getItem(STORAGE_ID) || '';
let teamName = localStorage.getItem(STORAGE_NAME) || '';
let latestState = null;
let serverOffset = 0;
let joinInFlight = false;
let seenResultAt = 0;
let reactionTimeout = null;

teamNameInput.value = teamName;

function syncClock(state) {
  serverOffset = state.serverTime - Date.now();
}

function setConnection(online) {
  connDot.classList.toggle('off', !online);
  connText.textContent = online ? 'online' : 'offline';
}

function getServerNow() {
  return Date.now() + serverOffset;
}

function formatSeconds(ms) {
  const value = Math.max(0, ms) / 1000;
  return value.toFixed(value < 10 ? 1 : 0);
}

function showReaction(points) {
  if (!points || points <= 0) return;
  reactionLine.textContent = `+${points}`;
  reactionLine.classList.remove('hidden');
  reactionLine.classList.remove('reaction');
  void reactionLine.offsetWidth;
  reactionLine.classList.add('reaction');
  if (reactionTimeout) clearTimeout(reactionTimeout);
  reactionTimeout = setTimeout(() => {
    reactionLine.classList.add('hidden');
  }, 1800);
}

function updateView() {
  if (!latestState) return;
  const state = latestState;

  const team = state.teams.find((item) => item.id === teamId);
  if (!team) {
    if (teamId || teamName) {
      teamId = '';
      teamName = '';
      localStorage.removeItem(STORAGE_ID);
      localStorage.removeItem(STORAGE_NAME);
      teamNameInput.value = '';
      joinError.textContent = '';
      seenResultAt = 0;
      reactionLine.classList.add('hidden');
    }
    document.body.classList.remove('playing');
    joinCard.classList.remove('hidden');
    buzzCard.classList.add('hidden');
    return;
  }

  document.body.classList.add('playing');
  joinCard.classList.add('hidden');
  buzzCard.classList.remove('hidden');
  teamLabel.textContent = team.name;
  teamNameDisplay.textContent = team.name;
  scoreLine.textContent = `Очки: ${team.score}`;
  const artistPoints = team.artistPoints || 0;
  const titlePoints = team.titlePoints || 0;
  const fullCount = team.fullCount || 0;
  const correctCount = team.correctCount || 0;
  const totalCorrectMs = Number.isFinite(team.totalCorrectMs) ? team.totalCorrectMs : 0;
  pointsLine.textContent = `Исполнитель: ${artistPoints} · Название: ${titlePoints} · Полные песни: ${fullCount}`;
  const minLabel =
    correctCount && team.minCorrectMs !== null ? `${formatSeconds(team.minCorrectMs)} секунды` : '—';
  const avgLabel =
    correctCount ? `${formatSeconds(totalCorrectMs / correctCount)} секунды` : '—';
  timesLine.textContent = `Минимум: ${minLabel} · Среднее: ${avgLabel}`;
  missesLine.textContent = `Промахи: ${team.misses || 0}`;

  if (state.lastResult && state.lastResult.at && state.lastResult.at > seenResultAt) {
    seenResultAt = state.lastResult.at;
    if (state.lastResult.teamId === teamId && state.lastResult.points > 0) {
      showReaction(state.lastResult.points);
    }
  }

  const roundText = state.roundNumber ? `Раунд ${state.roundNumber}` : 'Раунд —';
  roundLabel.textContent = roundText;

  const serverNow = getServerNow();
  const answerRemaining = state.answerEndsAt ? state.answerEndsAt - serverNow : 0;
  const lockoutRemaining = team.lockoutUntil ? team.lockoutUntil - serverNow : 0;

  timerLine.textContent = '';
  lockoutLine.textContent = '';
  timerLine.classList.remove('timer-active');
  lockoutLine.classList.remove('timer-lock');
  buzzBtn.classList.remove('answering', 'locked');
  buzzBtn.textContent = 'ЖМИ!';

  if (!state.roundActive) {
    const roundFinished = state.roundNumber > 0;
    statusLine.textContent = roundFinished ? 'Раунд завершен' : 'Ожидайте начала раунда';
    buzzBtn.disabled = true;
  } else if (state.currentAnsweringTeamId) {
    const answeringTeam = state.teams.find((item) => item.id === state.currentAnsweringTeamId);
    if (state.currentAnsweringTeamId === teamId) {
      statusLine.textContent = 'Ваша команда отвечает';
      buzzBtn.textContent = 'ГОВОРИТЕ';
      buzzBtn.classList.add('answering');
    } else {
      statusLine.textContent = `Отвечает команда: ${answeringTeam ? answeringTeam.name : '—'}`;
    }
    buzzBtn.disabled = true;
    if (state.answerEndsAt && state.currentAnsweringTeamId === teamId) {
      timerLine.textContent = answerRemaining > 0 ? `Осталось: ${formatSeconds(answerRemaining)}с` : 'Время вышло';
      if (state.currentAnsweringTeamId === teamId) {
        timerLine.classList.add('timer-active');
      }
    }
  } else if (lockoutRemaining > 0) {
    statusLine.textContent = 'Пауза после ответа';
    buzzBtn.disabled = true;
    buzzBtn.textContent = 'БЛОК';
    buzzBtn.classList.add('locked');
    lockoutLine.textContent = `Блокировка: ${formatSeconds(lockoutRemaining)}с`;
    lockoutLine.classList.add('timer-lock');
  } else {
    statusLine.textContent = 'Можно жать!';
    buzzBtn.disabled = false;
  }
}

function joinTeam(name) {
  if (joinInFlight) return;
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    joinError.textContent = 'Введите название команды.';
    return;
  }
  joinError.textContent = '';
  joinInFlight = true;
  joinBtn.disabled = true;

  socket.emit('join_team', { name: trimmed, teamId }, (res) => {
    joinInFlight = false;
    joinBtn.disabled = false;
    if (!res || !res.ok) {
      const reason = res?.error || 'unknown';
      joinError.textContent = reason === 'name_taken' ? 'Название уже занято.' : 'Ошибка подключения.';
      return;
    }

    teamId = res.teamId;
    teamName = res.name;
    localStorage.setItem(STORAGE_ID, teamId);
    localStorage.setItem(STORAGE_NAME, teamName);
    latestState = res.state;
    syncClock(latestState);
    updateView();
  });
}

joinBtn.addEventListener('click', () => joinTeam(teamNameInput.value));
teamNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') joinTeam(teamNameInput.value);
});

buzzBtn.addEventListener('click', () => {
  buzzBtn.disabled = true;
  socket.emit('buzz', (res) => {
    if (!res?.ok) {
      const reason = res?.reason;
      if (reason === 'locked') {
        statusLine.textContent = 'Пауза после ответа';
      } else if (reason === 'answer_in_progress') {
        statusLine.textContent = 'Дождитесь окончания ответа';
      } else if (reason === 'round_inactive') {
        statusLine.textContent = 'Раунд еще не стартовал';
      }
      return;
    }
    latestState = res.state;
    syncClock(latestState);
    updateView();
  });
});

socket.on('connect', () => {
  setConnection(true);
  if (teamName) {
    joinTeam(teamName);
  }
});

socket.on('disconnect', () => {
  setConnection(false);
});

socket.on('state_update', (state) => {
  latestState = state;
  syncClock(latestState);
  updateView();
});

setInterval(updateView, 200);
