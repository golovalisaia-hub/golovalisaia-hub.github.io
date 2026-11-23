import {getBearing,locationText} from './position-data.js';
import {readinessOverall,phoneChecks} from './readiness-state.js';

const el = id => document.getElementById(id);
const date = new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'medium'});
const number = new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1});
const phoneKey = 'quiet-field-phone-verification';
const firstUseKey = 'quiet-field-first-use-1';
const wakeKey = 'quiet-field-wake';
const labels = {VERIFIED:'Проверено',PARTIAL:'Частично',FAILED:'Сбой','NOT TESTED':'Не проверено'};
const titles = {
  map:'Карта Мурманской области',buildings:'Детализация зданий',forest:'Лесные дороги и тропы',
  search:'Офлайн-поиск',gps:'GPS',track:'Запись маршрута',car:'Возврат к машине',
  satellite:'Спутниковая карта',crypto:'Защита данных',phone:'Проверка на реальном телефоне',
};

function localRead(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function localWrite(key,value) {
  try { localStorage.setItem(key,value); } catch { /* Volatile preferences still work. */ }
}

function redact(el) {
  el.textContent = '';
  el.hidden = true;
}

function distanceLabel(distance) {
  return distance < 1000 ? Math.round(distance) + ' м' : number.format(distance/1000) + ' км';
}

export function createFieldSafety({getState,requestGps,onBegin,onEnd,onAnchor,onTrack,onWakeChange}) {
  const dialog = el('field-safety');
  const intro = el('first-field-use');
  const checklist = [...el('phone-verification').querySelectorAll('input[type=checkbox]')];
  const wake = el('field-wake');
  wake.checked = localRead(wakeKey) !== 'off';
  let receipt;
  try { receipt = JSON.parse(localRead(phoneKey)); } catch { /* A bad record grants no verification. */ }
  let acknowledged = localRead(firstUseKey) === 'yes';
  let target;
  let compass = null;
  let compassEnabled = false;
  let revision = 0;
  const rows = Object.entries(titles).map(([key,title]) => {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const badge = document.createElement('dd');
    const text = document.createElement('dd');
    term.textContent = title;
    badge.className = 'readiness-status';
    row.append(term,badge,text);
    el('field-readiness-list').append(row);
    return {key,badge,text};
  });

  function renderBearing(state) {
    if (!target) return;
    const fix = state.fix;
    const reading = fix && getBearing(fix,target);
    const direction = reading?.degrees ?? null;
    el('bearing-arrow').hidden = direction === null || !fix || fix.accuracy > 50;
    if (direction !== null) el('bearing-arrow').style.setProperty('--field-bearing',direction + 'deg');
    el('bearing-title').textContent = target.name;
    el('bearing-detail').textContent = !reading ? 'Нет свежей точки GPS.' :
      'По прямой ' + distanceLabel(reading.distance) + ' · ' +
      (fix.accuracy > 50 || direction === null ? 'азимут ненадёжен при этой точности' :
        'азимут ' + (Math.round(direction)%360) + '° от севера');
  }

  function render() {
    if (!target && !dialog.open) return;
    const state = getState();
    renderBearing(state);
    if (!dialog.open) return;
    const fix = state.fix || state.last;
    el('safety-position-status').textContent = state.positionLabel;
    el('safety-copy').disabled = !fix;
    el('safety-coordinates').hidden = !fix;
    el('safety-fix-details').hidden = !fix;
    el('safety-fix-extra').hidden = !state.fix || (state.fix.altitude === null && state.fix.speed === null && state.fix.heading === null);
    el('safety-coordinates').textContent = fix ? fix.lat.toFixed(6) + ', ' + fix.lng.toFixed(6) : '';
    el('safety-fix-details').textContent = fix ? 'Точность ±' + Math.ceil(fix.accuracy) + ' м · ' + date.format(fix.timestamp) : '';
    const current = state.fix;
    el('safety-fix-extra').textContent = current ? [
      current.altitude !== null && 'Высота ' + Math.round(current.altitude) + ' м',
      current.speed !== null && 'Скорость ' + number.format(current.speed * 3.6) + ' км/ч',
      current.heading !== null && 'Курс ' + (Math.round(current.heading)%360) + '°',
    ].filter(Boolean).join(' · ') : '';
    for (const kind of ['car','start']) {
      const point = state[kind];
      el('safety-return-' + kind).disabled = !point;
      el('safety-' + kind + '-status').textContent = point ?
        point.lat.toFixed(5) + ', ' + point.lng.toFixed(5) + (state.fix ?
          ' · ' + distanceLabel(getBearing(state.fix,point).distance) + ' по прямой' : '') :
        kind === 'car' ? 'Машина не отмечена.' : 'Старт не отмечен.';
    }
    el('safety-retrace').disabled = !state.hasPath;
    const phone = readinessOverall({version:state.version,ready:state.canConfirm,receipt});
    el('field-readiness-overall').textContent = phone.overall;
    el('field-readiness-overall').dataset.state = phone.phone === 'VERIFIED' ? 'VERIFIED' : 'PARTIAL';
    for (const {key,badge,text} of rows) {
      const [quality,detail] = key === 'phone' ? [phone.phone,phone.phoneLabel] :
        (state.rows[key] || ['NOT TESTED','']);
      badge.dataset.state = quality;
      badge.textContent = labels[quality];
      text.textContent = detail;
    }
    el('phone-confirm').disabled = !state.canConfirm || !state.version || phone.phone === 'VERIFIED' ||
      !phoneChecks.every(id => checklist.some(input => input.value === id && input.checked));
    el('phone-reset').hidden = !receipt;
  }

  function open() {
    if (!dialog.open) dialog.showModal();
    render();
  }

  function answerIntro(check) {
    acknowledged = true;
    localWrite(firstUseKey,'yes');
    intro.close();
    if (check) open();
  }

  function stopGuide() {
    if (!target) return;
    target = undefined;
    el('bearing-hud').hidden = true;
    el('bearing-title').textContent = '';
    el('bearing-detail').textContent = '';
    el('bearing-arrow').style.removeProperty('--field-bearing');
    el('bearing-hud').closest('.workspace').dataset.bearing = 'false';
    onEnd();
  }

  function guide(point) {
    target = {...point};
    if (dialog.open) dialog.close();
    el('bearing-hud').hidden = false;
    el('bearing-hud').closest('.workspace').dataset.bearing = 'true';
    onBegin(point);
    render();
  }

  function orientation(event) {
    const direction = event.webkitCompassHeading;
    const accuracy = event.webkitCompassAccuracy;
    const absolute = event.absolute || event.type === 'deviceorientationabsolute';
    const value = Number.isFinite(direction) && direction >= 0 && (!Number.isFinite(accuracy) || accuracy >= 0 && accuracy <= 45)
      ? direction : absolute && Number.isFinite(event.alpha) ? (360-event.alpha)%360 : null;
    if (value === null) return;
    compass = Math.round(value)%360;
    el('safety-compass-status').textContent = 'Корпус телефона · ' + compass + '° по компасу';
  }

  async function enableCompass() {
    const current = revision;
    const status = el('safety-compass-status');
    const api = globalThis.DeviceOrientationEvent;
    status.hidden = false;
    if (compassEnabled) {
      status.textContent = compass === null ? 'Пока нет показаний компаса.' : 'Корпус телефона · ' + compass + '° по компасу';
      return;
    }
    if (!api) { status.textContent = 'Компас телефона недоступен.'; return; }
    try {
      if (api.requestPermission && await api.requestPermission() !== 'granted') throw new Error('denied');
      if (current !== revision) return;
      compassEnabled = true;
      window.addEventListener('deviceorientation',orientation);
      window.addEventListener('deviceorientationabsolute',orientation);
      status.textContent = 'Ждём показания компаса телефона…';
    } catch {
      if (current === revision) status.textContent = 'Доступ к компасу телефона не получен.';
    }
  }

  function detachCompass() {
    revision += 1;
    if (!compassEnabled) return;
    window.removeEventListener('deviceorientation',orientation);
    window.removeEventListener('deviceorientationabsolute',orientation);
    compassEnabled = false;
    compass = null;
    redact(el('safety-compass-status'));
  }

  el('safety-open').addEventListener('click',open);
  el('first-field-confirm').addEventListener('click',() => answerIntro(false));
  el('first-field-check').addEventListener('click',() => answerIntro(true));
  el('safety-gps').addEventListener('click',requestGps);
  el('safety-compass').addEventListener('click',() => void enableCompass());
  el('bearing-stop').addEventListener('click',stopGuide);
  for (const kind of ['car','start']) {
    el('safety-return-' + kind).addEventListener('click',() => onAnchor(kind));
  }
  el('safety-retrace').addEventListener('click',() => { dialog.close(); onTrack(true); });
  el('safety-field-journal').addEventListener('click',() => { dialog.close(); onTrack(false); });
  el('safety-copy').addEventListener('click',async () => {
    const state = getState();
    const fix = state.fix || state.last;
    if (!fix) return;
    const current = revision;
    const text = (state.fix ? '' : 'Последняя известная позиция · ') + locationText(fix);
    try {
      if (!navigator.clipboard) throw new Error('clipboard');
      await navigator.clipboard.writeText(text);
      if (current !== revision || !dialog.open) return;
      el('safety-copy-status').textContent = 'Координаты скопированы.';
      el('safety-copy-status').hidden = false;
    } catch {
      if (current !== revision || !dialog.open) return;
      const field = el('safety-copy-fallback');
      field.value = text;
      field.hidden = false;
      field.focus();
      field.select();
    }
  });
  dialog.addEventListener('close',() => {
    detachCompass();
    el('safety-copy-fallback').value = '';
    el('safety-copy-fallback').hidden = true;
    redact(el('safety-copy-status'));
  });
  wake.addEventListener('change',() => {
    localWrite(wakeKey,wake.checked ? 'on' : 'off');
    onWakeChange();
  });
  checklist.forEach(input => input.addEventListener('change',render));
  el('phone-confirm').addEventListener('click',() => {
    const state = getState();
    const checks = checklist.filter(input => input.checked).map(input => input.value);
    if (!(state.canConfirm && state.version && phoneChecks.every(id => checks.includes(id)))) return;
    receipt = {version:state.version,checks};
    localWrite(phoneKey,JSON.stringify(receipt));
    render();
  });
  el('phone-reset').addEventListener('click',() => {
    receipt = null;
    checklist.forEach(input => { input.checked = false; });
    localWrite(phoneKey,'');
    render();
  });
  return {
    render,guide,stopGuide,isGuiding:() => Boolean(target),
    keepAwake:() => wake.checked,
    offerIntro() { if (!acknowledged && !intro.open) intro.showModal(); },
    lock() {
      detachCompass();
      stopGuide();
      if (dialog.open) dialog.close();
      if (intro.open) intro.close();
      for (const id of ['safety-position-status','safety-coordinates','safety-fix-details','safety-fix-extra','safety-copy-status','safety-compass-status']) {
        redact(el(id));
      }
      el('safety-position-status').hidden = false;
      el('safety-copy-fallback').value = '';
      el('safety-copy-fallback').hidden = true;
      el('safety-car-status').textContent = '';
      el('safety-start-status').textContent = '';
      for (const {text} of rows) text.textContent = '';
    },
  };
}
