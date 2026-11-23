import {openTrackStore} from './track-store.js';
import {backtrackProgress,makeBacktrack,TRACK_FIX_MAX_AGE_MS} from './track-geometry.js';
import {fitTrack,paintTrack} from './track-map.js';

const byId = id => document.getElementById(id);
const number = new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1});
const distance = meters => meters < 1000 ? Math.round(meters) + ' м' : number.format(meters / 1000) + ' км';
const size = bytes => number.format(bytes / 1024 / 1024) + ' МБ';
const coordinates = point => [point.lng,point.lat];
const validFix = fix => fix && [fix.lng,fix.lat,fix.timestamp,fix.accuracy].every(Number.isFinite) &&
  Math.abs(Date.now() - fix.timestamp) <= TRACK_FIX_MAX_AGE_MS;

export function createTrackPanel({getFix,requestGps,releaseGps,followGps,canRecord,onReturn,onStateChange,preparation,prepare,keepAwake,onFinish}) {
  const dialog = byId('track-dialog');
  let store;
  let failed = false;
  let trip;
  let previewTrack;
  let accessRevision = 0;
  let map;
  let phase = 'idle';
  let busy = false;
  let epoch = 0;
  let breakRevision = 0;
  let gap = false;
  let writes = Promise.resolve();
  let wakeLock;
  let note;
  let lastMatch;
  let route;
  let arrived = false;
  let lookingAtRoute = false;

  const isReturning = () => phase === 'locating' || phase === 'return';
  const shownTrack = () => previewTrack || trip;
  const hasPath = () => Boolean(shownTrack()?.segments.some(section => section.length > 1));
  const visibleNote = () => note || (trip ? 'Сохранено ' + distance(trip.distance) : 'Записи ещё нет.');

  function render() {
    const prep = preparation();
    byId('track-download-status').textContent = prep.ready ? 'Карта и пешие маршруты на устройстве' :
      prep.busy ? 'Скачиваем данные для похода…' :
      prep.bytes ? 'Ещё нужно скачать ' + size(prep.bytes) : 'Готовим сведения о загрузке…';
    const prepButton = byId('track-prepare');
    prepButton.textContent = prep.mapSaved ? 'Скачать пешие маршруты' : 'Скачать карту и пешие маршруты';
    prepButton.hidden = prep.ready || prep.busy;
    prepButton.disabled = !prep.available;
    const active = phase !== 'idle';
    const recording = phase === 'recording';
    const returning = isReturning();
    byId('track-open').dataset.active = String(active);
    byId('track-start').hidden = active;
    byId('track-start').disabled = !store || busy;
    byId('track-start').textContent = trip ? 'Продолжить запись' : 'Начать запись';
    byId('track-pause').hidden = !recording;
    byId('track-stop').hidden = returning || !trip?.segments.some(section => section.length);
    byId('track-stop').disabled = busy;
    byId('track-back').hidden = !hasPath() || returning;
    byId('track-back').disabled = busy;
    byId('track-show').hidden = !shownTrack()?.segments.some(section => section.length);
    byId('track-delete').hidden = !trip || active;
    byId('track-delete').disabled = busy;
    byId('track-stop-back').hidden = !returning;
    byId('track-hud').hidden = !active;
    byId('track-hud-title').textContent = recording ? 'Запись пути' : 'Назад по треку';
    byId('track-hud-detail').textContent = visibleNote();
    const state = byId('track-state');
    const body = visibleNote();
    if (state.textContent !== body) state.textContent = body;
    const fix = getFix();
    const copy = byId('track-coordinate');
    copy.hidden = !validFix(fix);
    copy.textContent = copy.hidden ? '' : `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)} · GPS ±${Math.ceil(fix.accuracy)} м`;
    onStateChange?.();
  }

  function repaint() {
    paintTrack(map,previewTrack || trip,route);
  }

  function overview(preferReturn = false,includeFix = false) {
    const selected = shownTrack();
    if (!selected) return false;
    const sections = preferReturn && route ? [route.coordinates] : selected.segments.map(section => section.map(coordinates));
    const fix = getFix();
    if (includeFix && validFix(fix) && canRecord(fix)) sections.push([coordinates(fix)]);
    return fitTrack(map,sections);
  }

  function releaseWakeLock() {
    void wakeLock?.release().catch(()=>{});
    wakeLock = undefined;
  }

  async function keepScreenOn() {
    if (!keepAwake() || wakeLock) return;
    const current = epoch;
    try {
      const lock = await navigator.wakeLock?.request('screen');
      if (current === epoch && phase !== 'idle' && !arrived && keepAwake() && !wakeLock) wakeLock = lock;
      else await lock?.release();
    } catch {
      // The map and recording continue while the display stays on.
    }
  }

  function suspend(message = '') {
    if (phase === 'idle') {
      render();
      return;
    }
    const recording = phase === 'recording';
    epoch += 1;
    phase = 'idle';
    route = undefined;
    lastMatch = undefined;
    arrived = false;
    gap = true;
    releaseWakeLock();
    followGps(false);
    note = message || (recording ? 'Запись на паузе. Путь сохранён.' : 'Возврат остановлен.');
    repaint();
    render();
    releaseGps();
  }

  function gpsIssue(signalLost = false) {
    if (signalLost && phase === 'recording') {
      gap = true;
      breakRevision += 1;
    }
    if (phase !== 'idle' && !arrived) {
      note = 'Ждём точное местоположение…';
    }
    render();
  }

  function applyMatch(fix) {
    if (arrived) return;
    if (phase === 'locating') {
      const result = makeBacktrack(shownTrack().segments,fix);
      if (result.status !== 'ready') {
        note = ({
          'off-track':'Ты в стороне от записанного пути. На карте виден сохранённый трек.',
          ambiguous:'Рядом несколько участков трека. Ждём более точное положение.',
          'too-short':'В этом месте пока слишком короткий участок для возврата.',
          'weak-fix':'Ждём точное местоположение…',
        })[result.status] || 'Ждём местоположение…';
        if (result.status !== 'weak-fix' && !lookingAtRoute) {
          lookingAtRoute = overview(false,true);
        }
        render();
        return;
      }
      route = result.route;
      phase = 'return';
      repaint();
      overview(true);
      followGps(true);
    }
    const progress = backtrackProgress(route,fix,lastMatch);
    if (progress.status === 'on-track' || progress.status === 'arrived') {
      lastMatch = progress;
      arrived = progress.status === 'arrived';
      if (arrived) {
        note = route.partial ? 'Начало участка. Дальше в записи есть разрыв.' : 'Ты у начала записанного пути.';
        releaseWakeLock();
        followGps(false);
      } else {
        note = 'Осталось ' + distance(progress.remainingDistance) + (route.partial ? ' до начала участка' : ' до начала пути');
      }
    } else if (progress.status === 'off-track') {
      note = 'Ты в стороне от линии трека.';
    } else if (progress.status === 'ambiguous') {
      note = 'Рядом несколько участков. Ждём более точное положение.';
    } else {
      note = 'Ждём точное местоположение…';
    }
    render();
  }

  function updateFix(fix) {
    if (!canRecord(fix)) {
      if (phase === 'recording') gpsIssue(true);
      if (phase !== 'idle' && !arrived) note = 'GPS за пределами скачанной области.';
      render();
      return;
    }
    if (isReturning()) {
      applyMatch(fix);
      return;
    }
    if (phase !== 'recording') {
      if (dialog.open) render();
      return;
    }
    const current = epoch;
    const id = trip.id;
    const observedBreak = breakRevision;
    writes = writes.then(async () => {
      if (current !== epoch || phase !== 'recording') return;
      const result = await store.append(id,fix,{breakBefore:gap});
      if (!result.point) {
        if (current === epoch && result.reason !== 'duplicate') gpsIssue(true);
        return;
      }
      if (trip?.id !== id) return;
      if (result.breakBefore || !trip.segments.length) trip.segments.push([]);
      trip.segments.at(-1).push(result.point);
      trip.distance = result.distance;
      if (current === epoch) {
        if (observedBreak === breakRevision) {
          gap = false;
          note = 'Записано ' + distance(trip.distance);
        }
      }
      repaint();
      render();
    }).catch(() => {
      if (current === epoch) suspend('Не удалось сохранить точку. Проверь хранилище и продолжи запись.');
    });
  }

  async function startRecording() {
    if (phase !== 'idle' || busy || !store) return;
    const db = store;
    const access = accessRevision;
    busy = true;
    render();
    try {
      await writes;
      if (access !== accessRevision) return;
      const saved = await db.load();
      if (access !== accessRevision || document.hidden) return;
      const next = saved || await db.create();
      if (access !== accessRevision || document.hidden) return;
      trip = next;
      previewTrack = undefined;
      epoch += 1;
      gap = trip.segments.length > 0;
      phase = 'recording';
      note = 'Ждём точное местоположение…';
      dialog.close();
      requestGps();
      if (validFix(getFix())) updateFix(getFix());
      void keepScreenOn();
    } catch {
      if (access === accessRevision) note = 'Не удалось открыть запись. Попробуй открыть «Мой путь» снова.';
    } finally {
      if (access === accessRevision) { busy = false; render(); }
    }
  }

  async function startReturn() {
    if (!store || !hasPath() || busy || isReturning()) return;
    if (phase === 'recording') suspend();
    const db = store;
    const access = accessRevision;
    busy = true;
    render();
    try {
      await writes;
      if (access !== accessRevision) return;
      const saved = previewTrack || await db.load();
      if (access !== accessRevision || document.hidden) return;
      if (!previewTrack) trip = saved;
      if (!hasPath()) return;
      onReturn();
      epoch += 1;
      phase = 'locating';
      lookingAtRoute = false;
      note = 'Ждём точное местоположение…';
      dialog.close();
      requestGps();
      if (validFix(getFix())) updateFix(getFix());
      void keepScreenOn();
    } catch {
      if (access === accessRevision) suspend('Не удалось открыть путь на устройстве.');
    } finally {
      if (access === accessRevision) { busy = false; render(); }
    }
  }

  async function finishRecording() {
    if (!store || busy || !trip || isReturning()) return;
    const db = store;
    const access = accessRevision;
    busy = true;
    suspend();
    try {
      await writes;
      if (access !== accessRevision) return;
      const saved = await db.load();
      if (access !== accessRevision || !saved) return;
      const archived = await onFinish(saved);
      if (access !== accessRevision) return;
      if (!archived) { note = 'Трек остался на паузе. Не удалось сохранить его в журнал.'; return; }
      if (!await db.delete(saved.id,saved.revision)) {
        if (access === accessRevision) note = 'Копия сохранена. Текущая запись изменилась в другой вкладке.';
        return;
      }
      if (access !== accessRevision) return;
      trip = undefined;
      previewTrack = saved;
      note = 'Трек сохранён в журнале.';
      repaint();
    } catch {
      if (access === accessRevision) note = 'Трек остался на паузе. Проверь свободное место.';
    } finally {
      if (access === accessRevision) { busy = false; render(); }
    }
  }

  async function remove() {
    if (!store || busy || phase !== 'idle' || !trip) return;
    const db = store;
    const access = accessRevision;
    const tripId = trip.id;
    busy = true;
    render();
    try {
      await writes;
      if (access !== accessRevision) return;
      await db.delete(tripId);
      if (access !== accessRevision) return;
      const saved = await db.load();
      if (access !== accessRevision) return;
      trip = saved;
      note = trip ? undefined : 'Путь удалён с устройства.';
      repaint();
    } catch {
      if (access === accessRevision) note = 'Не удалось удалить путь.';
    } finally {
      if (access === accessRevision) {
        busy = false;
        byId('track-delete-confirmation').hidden = true;
        render();
      }
    }
  }

  byId('track-open').addEventListener('click',() => {
    render();
    dialog.showModal();
  });
  byId('track-prepare').addEventListener('click',() => {
    dialog.close();
    void prepare();
  });
  byId('track-start').addEventListener('click',() => void startRecording());
  byId('track-pause').addEventListener('click',() => suspend());
  byId('track-stop').addEventListener('click',() => void finishRecording());
  byId('track-back').addEventListener('click',() => void startReturn());
  byId('track-stop-back').addEventListener('click',() => suspend());
  byId('track-show').addEventListener('click',() => {
    if (overview(isReturning(),true)) {
      followGps(false);
      dialog.close();
    }
  });
  byId('track-delete').addEventListener('click',() => { byId('track-delete-confirmation').hidden = false; });
  byId('track-cancel-delete').addEventListener('click',() => { byId('track-delete-confirmation').hidden = true; });
  byId('track-confirm-delete').addEventListener('click',() => void remove());
  dialog.addEventListener('close',() => { byId('track-delete-confirmation').hidden = true; });

  async function unlock(key) {
    const current = ++accessRevision;
    failed = false;
    note = 'Открываем хранилище трека…';
    render();
    try {
      const opened = await openTrackStore(key);
      if (current !== accessRevision) { opened.close?.(); return; }
      const saved = await opened.load();
      if (current !== accessRevision) { opened.close?.(); return; }
      trip = saved;
      store = opened;
      note = undefined;
      repaint();
    } catch {
      if (current === accessRevision) {
        failed = true;
        note = 'Не удалось открыть зашифрованный путь.';
      }
    } finally {
      if (current === accessRevision) render();
    }
  }
  function lock() {
    accessRevision += 1;
    suspend();
    const activeStore = store;
    store = undefined;
    failed = false;
    busy = false;
    trip = undefined;
    previewTrack = undefined;
    note = undefined;
    void writes.finally(() => activeStore?.close?.());
    repaint();
    render();
  }
  function showSaved(saved) {
    suspend();
    previewTrack = saved;
    repaint();
    render();
    if (fitTrack(map,saved.segments.map(section => section.map(coordinates)))) dialog.close();
  }

  return {
    render,updateFix,gpsIssue,suspend,isReturning,unlock,lock,showSaved,
    status:() => ({ready:Boolean(store),failed,hasPath:hasPath()}),
    retrace:() => void startReturn(),
    updateWakePreference() {
      if (!keepAwake()) releaseWakeLock();
      else if (phase !== 'idle' && !arrived) void keepScreenOn();
    },
    isActive:() => phase !== 'idle',
    snapshot:() => trip,
    setMap(next) { map = next; repaint(); },
    stopReturn() { if (isReturning()) suspend(); },
    showOverview() { return isReturning() && overview(true,true); },
  };
}
