import {createMap} from './map-engine.js';
import {regionInfo,navigationInfo,walkingInfo,createMapStorage,checkStorage} from './region-storage.js';
import {hasHouseNumber} from './address-search.js';
import {createNavigationUI} from './navigation-ui.js';
import {createLayerPanel} from './layer-panel.js';
import {createTrackPanel} from './track-panel.js';
import {createFieldPanel} from './field-panel.js';
import {createPrivacyLock} from './privacy-lock.js';
import {createForestryTools} from './forestry-tools.js';
import {createFieldSafety} from './field-safety.js';
import {getBearing,readGpsFix,inAdministrativeRegion} from './position-data.js';
import {TRACK_FIX_MAX_AGE_MS} from './track-geometry.js';

const el = id => document.getElementById(id);
const search = el('region-search');
const library = document.querySelector('.library');
const mapPanel = el('map-panel-content');
const workers = navigator.serviceWorker;
const portraitPhone = window.matchMedia('(max-width:680px) and (orientation:portrait)');
const visibleViewport = window.visualViewport;
const results = el('places');
const mapCanvas = el('map');
const mapButtons = ['zoom-in','zoom-out','fit-region','my-position','map-north','pick-destination'].map(el);
const format = new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1});
const workspace = document.querySelector('.workspace');
const buildingTypes = {
  apartments:'Многоквартирный дом',house:'Жилой дом',detached:'Жилой дом',residential:'Жилое здание',
  commercial:'Коммерческое здание',retail:'Магазин',school:'Школа',hospital:'Больница',
  warehouse:'Склад',industrial:'Промышленное здание',garage:'Гараж',garages:'Гаражи',
  cabin:'Хижина',hut:'Хижина',shed:'Хозяйственная постройка',office:'Офисное здание',
};
const fieldKinds = {
  track:'Полевая дорога',path:'Тропа',footway:'Пешеходная дорожка',
  steps:'Ступени',bridleway:'Верховая тропа',cycleway:'Велодорожка',service:'Служебный проезд',
  unclassified:'Местная дорога',residential:'Жилая улица',ford:'Брод',spring:'Источник',
  stream:'Ручей',river:'Река',ditch:'Канава',drain:'Водосток',canal:'Канал',
  primary:'Основная дорога',secondary:'Второстепенная дорога',tertiary:'Местная дорога',
};
const surfaces = {
  paved:'твёрдое покрытие',asphalt:'асфальт',concrete:'бетон',unpaved:'без твёрдого покрытия',
  gravel:'гравий',fine_gravel:'мелкий гравий',dirt:'грунт',ground:'грунт',sand:'песок',
  grass:'трава',mud:'грязь',rock:'камни',wood:'дерево',winter_road:'зимник',
};
const roadSmoothness = {
  excellent:'отличная',good:'хорошая',intermediate:'средняя',bad:'плохая',very_bad:'очень плохая',
  horrible:'крайне неровная',very_horrible:'особо неровная',impassable:'непроезжая',
};
const accessTypes = {
  yes:'доступ обозначен как открытый',permissive:'разрешение владельца может измениться',
  private:'частный доступ',no:'доступ запрещён',destination:'только для подъезда к объекту',
  designated:'обозначенный проход',customers:'для посетителей',permit:'требуется разрешение',
};

let data;
let geography;
let indexedPlaces = [];
let navigationData;
let walkingData;
let offlineReady = false;
let cachedArchive;
let cachedManifest;
let navigationArchive;
let navigationManifest;
let walkingArchive;
let walkingManifest;
let shellVersion = '';
let shellTimer;
let registeringShell = false;
let preview;
let map;
let mapStorage;
let mapRendered = false;
let mapFailed = false;
let storageFailed = false;
let mapRevision = 0;
let download;
let removingDownload = false;
let diskBytes = 0;
let navigationBytes = 0;
let walkingBytes = 0;
let searchRevision = 0;
let focusPlace;
let position;
let lastFix;
let positionFault = '';
let positionTimer;
const navigation = createNavigationUI({
  getFix:() => position?.sample,
  requestGps() {
    safety.stopGuide();
    startPosition(false,true,'navigation');
  },
  followGps(enabled) { if (position) position.follow = enabled; },
  onSelect:place => visit(place),
  onModeChange:renderDownload,
  canPickFromMap:() => !forestry.isDrawing(),
  onClear() {
    focusPlace = undefined;
    el('map-title').textContent = 'Мурманская область';
  },
});
const layerPanel = createLayerPanel({
  getMap:() => map,
  isReady:() => Boolean(offlineReady && mapStorage),
  isBaseDownloading:() => Boolean(download || removingDownload),
  downloadChanged:renderDownload,
});
const trackPanel = createTrackPanel({
  getFix:() => position?.sample,
  requestGps:() => startPosition(false,false,'track'),
  releaseGps() {
    if (position?.owner !== 'track' || workspace.dataset.guiding === 'true') return;
    if (safety.isGuiding()) position.owner = 'bearing';
    else stopPosition();
  },
  followGps(enabled) { if (position) position.follow = enabled; },
  canRecord({lng,lat}) { return inRegion(lng,lat); },
  onStateChange() { fieldPanel.render(); safety.render(); },
  onReturn() { safety.stopGuide(); navigation.clear(); sheet(false); },
  keepAwake:() => safety.keepAwake(),
  onFinish:track => fieldPanel.archiveTrack(track),
  preparation() {
    const vector = layerPanel.vectorState();
    const mapSaved = Boolean(cachedArchive && vector.ready);
    const pending = pendingParts(true);
    const bytes = pending.reduce((sum,part) => sum + part.manifest.bytes - part.saved(),0);
    return {
      ready:Boolean(offlineReady && mapSaved && walkingArchive && !pending.length),
      available:Boolean(offlineReady && data && vector.available && walkingData && !download && !removingDownload && !layerPanel.isBusy()),
      busy:Boolean(download?.walking),bytes,mapSaved,
    };
  },
  prepare() { sheet(true); return beginDownload(true); },
});
const fieldPanel = createFieldPanel({
  getFix:() => position?.sample,
  requestGps:() => startPosition(false),
  canSave:fix => inRegion(fix.lng,fix.lat),
  getTrack:trackPanel.snapshot,
  showTrack:trackPanel.showSaved,
  selectPlace:visit,
  canPickFromMap:() => !forestry.isDrawing(),
  onChange() { safety.render(); if (search.value) void renderPlaces(); },
  onBearing:point => safety.guide(point),
});
const forestry = createForestryTools({
  mapArea:mapCanvas.closest('.map-area'),trigger:el('forestry-open'),
  canMeasure:([lng,lat]) => inRegion(lng,lat),
  onStartDraw() {
    navigation.cancelPicking();
    if (position) position.follow = false;
  },
  onChange() { if (search.value) void renderPlaces(); },
});
const safety = createFieldSafety({
  getState:safetyState,
  requestGps:() => startPosition(true,false,'map'),
  onBegin() {
    trackPanel.stopReturn();
    navigation.clear();
    startPosition(true,false,'bearing');
  },
  onEnd() {
    if (position?.owner !== 'bearing') return;
    if (trackPanel.isActive()) position.owner = 'track';
    else stopPosition();
  },
  onAnchor:kind => fieldPanel.guide(kind),
  onTrack(retrace) { if (retrace) trackPanel.retrace(); else el('track-open').click(); },
  onWakeChange:() => trackPanel.updateWakePreference(),
});
const privacy = createPrivacyLock({
  onUnlock(key) {
    void trackPanel.unlock(key);
    void fieldPanel.unlock(key);
    void forestry.unlock(key);
    void loadMaps(key);
    safety.offerIntro();
  },
  onLock() {
    mapStorage?.close();
    mapStorage = undefined;
    download?.controller.abort();
    layerPanel.lock();
    clearPrivateSession();
    trackPanel.lock();
    fieldPanel.lock();
    forestry.lock();
    safety.lock();
    navigation.setMap(null);
    trackPanel.setMap(null);
    fieldPanel.setMap(null);
    forestry.setMap(null);
    mapRevision += 1;
    map?.destroy();
    map = null;
    preview = undefined;
    cachedArchive = undefined;
    cachedManifest = undefined;
    navigationArchive = undefined;
    navigationManifest = undefined;
    navigationData = undefined;
    walkingArchive = undefined;
    walkingManifest = undefined;
    walkingData = undefined;
    data = undefined;
    geography = undefined;
    indexedPlaces = [];
    diskBytes = 0;
    navigationBytes = 0;
    walkingBytes = 0;
    mapRendered = false;
    renderDownload();
  },
});

function size(bytes) {
  return format.format(bytes / 1024 / 1024) + ' МБ';
}

function sheet(expanded, panel = '') {
  library.dataset.expanded = String(expanded);
  library.dataset.panel = expanded ? panel : '';
  el('sheet-toggle').setAttribute('aria-expanded', String(expanded));
  el('sheet-toggle').setAttribute('aria-label', expanded ? 'Свернуть панель карты' : 'Развернуть панель карты');
  el('offline-panel').setAttribute('aria-expanded', String(expanded && panel === 'offline'));
}

function positionSearchAboveKeyboard() {
  if (!visibleViewport) return;
  // Safari moves and shrinks the visual viewport when its keyboard opens.
  const keyboard = portraitPhone.matches && document.activeElement === search &&
    Math.abs(visibleViewport.scale - 1) < .01 &&
    document.documentElement.clientHeight - visibleViewport.height > 120;
  workspace.dataset.keyboard = String(keyboard);
  if (keyboard) {
    workspace.style.setProperty('--keyboard-height', Math.floor(visibleViewport.height) + 'px');
    workspace.style.setProperty('--keyboard-offset', Math.round(visibleViewport.offsetTop) + 'px');
  } else {
    workspace.style.removeProperty('--keyboard-height');
    workspace.style.removeProperty('--keyboard-offset');
  }
}

function setNotice(text = '', error = false) {
  el('notice').textContent = text;
  el('notice').hidden = !text;
  el('notice').dataset.error = String(error);
  library.dataset.notice = String(Boolean(text));
}

function atVersion(target,installed) {
  return Boolean(target && installed && installed.version === target.version);
}

function pendingParts(walking) {
  const parts = [];
  if (data && !atVersion(data,cachedManifest)) parts.push({
    manifest:data,saved:() => diskBytes,
    progress(bytes) { diskBytes = bytes; },
    installed(archive) { cachedArchive = archive; cachedManifest = data; if (privacy.isUnlocked()) drawMap(); },
  });
  parts.push(...layerPanel.vectorParts());
  if (walking && walkingData && !atVersion(walkingData,walkingManifest)) parts.push({
    manifest:walkingData,saved:() => walkingBytes,
    progress(bytes) { walkingBytes = bytes; },
    installed(archive) { walkingArchive = archive; walkingManifest = walkingData; },
  });
  if (!walking && navigationData && !atVersion(navigationData,navigationManifest)) parts.push({
    manifest:navigationData,saved:() => navigationBytes,
    progress(bytes) { navigationBytes = bytes; },
    installed(archive) { navigationArchive = archive; navigationManifest = navigationData; },
  });
  return parts;
}

function renderDownload() {
  const vector = layerPanel.vectorState();
  const parts = pendingParts(false);
  const ready = Boolean(cachedArchive && vector.ready && (navigationArchive || !navigationData) && !parts.length);
  const update = Boolean(cachedArchive && vector.ready && parts.some(({manifest}) =>
    manifest.kind !== 'navigation' || navigationArchive));
  if (cachedArchive) el('map-state').textContent = vector.ready ? 'Карта сохранена' : 'Основная карта · добавь детализацию';
  const total = parts.reduce((sum,part) => sum + part.manifest.bytes - part.saved(),0);
  const expected = download?.expected || 0;
  const payload = download?.parts.reduce((sum,part) => sum + part.saved(),0) || 0;
  const percent = expected ? Math.floor(payload / expected * 100) : 0;
  el('offline-label').textContent = ready ?
    (navigationArchive ? 'Карта и навигация на устройстве' : 'Карта на устройстве') :
    update ? 'Старая версия доступна · обновление ' + size(total) :
    vector.available && data ? 'Подробная карта области · осталось ' + size(total) :
    vector.loaded ? 'Не удалось открыть пакет детализации. Обнови страницу с интернетом.' : 'Подготовка карты…';
  el('download-region').textContent = ready ? 'Карта скачана' :
    update ? 'Обновить карту области' :
    cachedArchive && vector.ready && !navigationBytes ? 'Скачать автомобильные маршруты' :
    !cachedArchive && diskBytes ? 'Продолжить загрузку' : 'Скачать Мурманскую область';
  library.dataset.ready = String(ready);
  el('download-region').disabled = !offlineReady || !data || (!vector.available && !vector.ready) || ready || Boolean(download) || removingDownload || layerPanel.isBusy();
  el('download-region').hidden = Boolean(download);
  el('delete-region').hidden = (diskBytes === 0 && navigationBytes === 0 && walkingBytes === 0) || Boolean(download);
  el('delete-region').disabled = removingDownload || layerPanel.isBusy();
  el('progress-region').hidden = !download;
  el('download-progress').value = percent;
  el('progress-copy').textContent = expected ? `${percent}% · ${size(payload)} из ${size(expected)}` : '';
  navigation.useArchive(navigationArchive,Boolean(cachedArchive && offlineReady));
  navigation.useWalkingArchive(walkingArchive,Boolean(cachedArchive && offlineReady));
  const routeData = navigation.mode() === 'walk' ? walkingData : navigationData;
  el('enable-navigation').disabled = !offlineReady || !routeData || Boolean(download) || removingDownload || layerPanel.isBusy();
  layerPanel.render();
  trackPanel.render();
}

function updateConnection() {
  const offline = !navigator.onLine;
  el('connection').dataset.offline = String(offline);
  el('connection-text').textContent = offline ? 'Без сети' : 'В сети';
}

function positionMessage(text = '', temporary = false) {
  clearTimeout(positionTimer);
  el('position-message').textContent = text;
  el('position-message').hidden = !text;
  if (temporary) positionTimer = setTimeout(() => positionMessage(), 5500);
}

function stopPosition(text = '',fault = '') {
  const watch = position;
  position = null;
  positionFault = fault;
  clearTimeout(watch?.expiry);
  if (watch?.id !== undefined) navigator.geolocation.clearWatch(watch.id);
  if (lastFix) paintPosition();
  else map?.clearPosition();
  el('my-position').setAttribute('aria-pressed','false');
  el('my-position').title = 'Моё местоположение';
  positionMessage(text || (lastFix ? 'Последняя известная позиция' : ''),Boolean(text) && !trackPanel.isActive());
  navigation.unavailable(text);
  trackPanel.suspend(text);
  fieldPanel.render();
  safety.render();
}

function paintPosition() {
  const live = position?.sample;
  const fix = live || lastFix;
  if (!fix || !map) return;
  const recenter = Boolean(live && position.centerOnNextFix && position.follow);
  const onMap = map.setPosition({...fix,stale:!live,follow:Boolean(live && position.follow),recenter});
  if (recenter && onMap) position.centerOnNextFix = false;
  if (live) positionMessage(onMap === false || (geography && !inRegion(live.lng,live.lat)) ?
    'Ты за пределами скачанной Мурманской области' :
    live.accuracy > 50 ? 'Низкая точность GPS · около ' + Math.ceil(live.accuracy) + ' м' : '');
}

function togglePosition() {
  if (position && !position.follow && position.sample) {
    position.follow = true;
    position.owner = 'map';
    position.centerOnNextFix = true;
    paintPosition();
    return;
  }
  if (position) {
    stopPosition(trackPanel.isActive() ? 'GPS выключен. Запись или возврат остановлены.' : '');
    return;
  }
  startPosition(true);
}

function positionLost(watch) {
  if (position !== watch) return;
  clearTimeout(watch.expiry);
  watch.sample = undefined;
  positionFault = 'lost';
  paintPosition();
  positionMessage(lastFix ? 'Последняя известная позиция · сейчас нет сигнала GPS' : 'Нет сигнала GPS');
  navigation.gpsIssue('GPS пока недоступен. Попробуй построить маршрут ещё раз.');
  trackPanel.gpsIssue(true);
  fieldPanel.render();
  safety.render();
}

function startPosition(follow,restart = false,owner = 'map') {
  if (!privacy.isUnlocked() || document.hidden) return;
  if (position && !restart) {
    if (follow) {
      position.follow = true;
      position.centerOnNextFix = true;
      paintPosition();
    }
    return;
  }
  if (!navigator.geolocation) {
    const message = 'Геопозиция недоступна в этом браузере.';
    stopPosition(message,'unavailable');
    return;
  }
  if (position?.id !== undefined) navigator.geolocation.clearWatch(position.id);
  clearTimeout(position?.expiry);
  const watch = {follow,owner,sample:null,centerOnNextFix:follow};
  position = watch;
  positionFault = 'waiting';
  el('my-position').setAttribute('aria-pressed','true');
  el('my-position').title = 'Выключить геопозицию';
  positionMessage('Ищем сигнал GPS…');
  safety.render();
  watch.id = navigator.geolocation.watchPosition(
    reading => {
      if (position !== watch || document.hidden) return;
      const now = Date.now();
      const sample = readGpsFix(reading,now);
      if (!sample) {
        if (!watch.sample || now - watch.sample.timestamp >= TRACK_FIX_MAX_AGE_MS) positionLost(watch);
        return;
      }
      if (lastFix && sample.timestamp < lastFix.timestamp) return;
      clearTimeout(watch.expiry);
      const remaining = TRACK_FIX_MAX_AGE_MS - Math.max(0,now - sample.timestamp);
      watch.sample = lastFix = sample;
      positionFault = '';
      watch.expiry = setTimeout(() => positionLost(watch),remaining);
      paintPosition();
      navigation.updateFix(watch.sample);
      trackPanel.updateFix(watch.sample);
      fieldPanel.render();
      safety.render();
      if (trackPanel.isActive() || workspace.dataset.guiding === 'true') privacy.activity();
    },
    ({code}) => {
      if (position !== watch) return;
      if (code === 1) stopPosition('Разреши доступ к геопозиции в настройках iPhone.','denied');
      else positionLost(watch);
    },
    {enableHighAccuracy:true, maximumAge:2000, timeout:18000},
  );
}

function safetyState() {
  const vector = layerPanel.vectorState();
  const field = fieldPanel.snapshot();
  const track = trackPanel.status();
  const fix = position?.sample;
  const goodFix = fix && fix.accuracy <= 50 && inRegion(fix.lng,fix.lat);
  const mapReady = Boolean(offlineReady && cachedArchive && mapRendered && !mapFailed && vector.ready);
  const packageVersion = [shellVersion,cachedManifest?.version,...vector.versions,walkingManifest?.version];
  const version = packageVersion.every(Boolean) ? packageVersion.join('|') : '';
  const bearing = goodFix && field.car ? getBearing(fix,field.car) : null;
  let positionLabel = 'Нет сигнала GPS';
  if (fix) positionLabel = !inRegion(fix.lng,fix.lat) ? 'Текущая позиция за границей скачанной области' :
    goodFix ? 'Текущая позиция GPS' : 'Низкая точность GPS';
  else if (lastFix) positionLabel = 'Последняя известная позиция';
  else if (positionFault === 'waiting') positionLabel = 'Ищем сигнал GPS…';
  else if (positionFault === 'denied') positionLabel = 'Нет сигнала GPS · доступ запрещён';
  const gpsFault = positionFault === 'denied' || positionFault === 'unavailable' ||
    (positionFault === 'lost' && !lastFix);
  const sourceDate = geography?.asOf?.slice(0,10);
  const datedForest = sourceDate ? 'Срез OSM за ' + sourceDate + '. ' : '';
  return {
    fix,last:lastFix,positionLabel,car:field.car,start:field.start,hasPath:track.hasPath,version,
    canConfirm:Boolean(mapReady && walkingArchive && geography && field.ready && track.ready),
    rows:{
      map:mapReady ? ['VERIFIED','Проверены архивы и чтение карты на устройстве.'] :
        mapFailed || storageFailed ? ['FAILED','Карта или хранилище не открылись.'] :
        ['PARTIAL',cachedArchive ? 'Проверяется полная детализация.' : 'Полная карта ещё не скачана.'],
      buildings:vector.detail && mapRendered ? ['VERIFIED','Пакет контуров доступен на устройстве.'] :
        ['PARTIAL','Для контуров домов скачай подробную карту.'],
      forest:vector.forest && vector.field && cachedArchive && mapRendered ?
        ['VERIFIED',datedForest + 'Проходимость оценивай на месте.'] :
        ['PARTIAL','Для подробных лесных дорог и троп скачай полную карту.'],
      search:navigationArchive && geography ? ['VERIFIED','Местный указатель и адресный справочник открыты.'] :
        ['PARTIAL','Номера домов и другие объекты зависят от скачанных справочников.'],
      gps:goodFix ? ['VERIFIED',positionLabel + ' · точность ±' + Math.ceil(fix.accuracy) + ' м.'] :
        [gpsFault ? 'FAILED' : fix || lastFix ? 'PARTIAL' : 'NOT TESTED',positionLabel],
      track:track.failed ? ['FAILED','Хранилище трека недоступно.'] :
        track.hasPath || field.trackCount ? ['VERIFIED','Сохранённая запись читается.'] :
        ['NOT TESTED','Запиши и открой короткий тестовый трек на телефоне.'],
      car:bearing?.degrees != null ? ['VERIFIED','Вычислен азимут к сохранённой точке.'] :
        ['PARTIAL',field.car ? 'Для уверенного азимута нужна свежая точка GPS.' : 'Машина ещё не отмечена.'],
      satellite:vector.satellite && mapRendered ? ['VERIFIED','Региональный пакет Sentinel-2 доступен на устройстве.'] :
        ['NOT TESTED','Скачай снимки, если они нужны в поездке.'],
      crypto:field.ready && track.ready ? ['VERIFIED','Зашифрованные хранилища открыты локальным ключом.'] :
        [field.failed || track.failed ? 'FAILED' : 'NOT TESTED','Хранилища проверяются при разблокировке.'],
    },
  };
}

function propertyLabel(dictionary,value) {
  return Object.hasOwn(dictionary,value) ? dictionary[value] : value;
}

function fieldFacts(tags) {
  const {surface,tracktype,smoothness,access,foot,motor_vehicle,ford,bridge,seasonal,state,highway} = tags;
  return [
    (highway || tags.kind === 'ford') && (access ?
      'Доступ · ' + propertyLabel(accessTypes,access) : 'Доступ не указан в OpenStreetMap'),
    surface && 'Покрытие · ' + propertyLabel(surfaces,surface),
    tracktype && 'Состояние покрытия по OSM · ' + tracktype,
    smoothness && 'Ровность по OSM · ' + propertyLabel(roadSmoothness,smoothness),
    foot && 'Пешком · ' + propertyLabel(accessTypes,foot),
    motor_vehicle && 'Моторный транспорт · ' + propertyLabel(accessTypes,motor_vehicle),
    bridge && bridge !== 'no' && 'Есть отметка моста',
    ford && ford !== 'no' && 'Есть отметка брода',
    seasonal && seasonal !== 'no' && 'Сезонный объект',
    state === 'inactive' && 'В источнике отмечен как заброшенный или выведенный из использования',
  ].filter(Boolean);
}

function canInspectMap() {
  return el('pick-destination').getAttribute('aria-pressed') !== 'true' &&
    workspace.dataset.guiding !== 'true' && !trackPanel.isReturning() && !forestry.isDrawing();
}

function drawMap() {
  const revision = ++mapRevision;
  mapRendered = false;
  mapFailed = false;
  navigation.setMap(null);
  trackPanel.setMap(null);
  fieldPanel.setMap(null);
  forestry.setMap(null);
  map?.destroy();
  map = null;
  const archive = cachedArchive || preview;
  const packData = cachedManifest || data;
  if (!archive || !packData) {
    mapFailed = true;
    el('map-loading').textContent = 'Карта недоступна. Проверь скачанные данные.';
    el('map-loading').hidden = false;
    safety.render();
    return;
  }
  const pack = {...packData.region,maxZoom:cachedArchive ? packData.region.maxZoom : packData.previewZoom};
  el('map-title').textContent = focusPlace?.name || 'Мурманская область';
  el('map-state').textContent = cachedArchive ?
    layerPanel.vectorState().ready ? 'Карта сохранена' : 'Основная карта · добавь детализацию' :
    'Обзор · скачай карту';
  el('map-loading').textContent = 'Открываем карту…';
  el('map-loading').hidden = false;
  mapButtons.forEach(button => button.disabled = true);
  try {
    map = createMap({
      container:mapCanvas,
      pack,
      archive,
      onReady(activeMap) {
        if (revision !== mapRevision) return;
        mapRendered = true;
        el('map-loading').hidden = true;
        mapButtons.forEach(button => button.disabled = false);
        navigation.setMap(activeMap);
        trackPanel.setMap(activeMap);
        fieldPanel.setMap(activeMap);
        forestry.setMap(activeMap);
        layerPanel.paint();
        if (focusPlace) map?.visit(focusPlace.center, parkingZoom(focusPlace));
        paintPosition();
        safety.render();
      },
      onBuilding({properties,center}) {
        if (!canInspectMap()) return;
        const {number,street,name,locality,levels,type,source} = properties;
        const address = [street,number].filter(Boolean).join(', ');
        const title = name || (street ? address : number ? 'Дом ' + number : 'Здание');
        const provenance = source === 'overture' ? 'Overture Maps' : 'OpenStreetMap';
        const detail = [name && address,locality,buildingTypes[type],levels && levels + ' эт.',
          center[1].toFixed(5) + ', ' + center[0].toFixed(5),provenance].filter(Boolean).join(' · ');
        visit({name:title,detail,center,kind:'building'});
      },
      onFieldFeature({properties,center}) {
        if (!canInspectMap()) return;
        const type = Object.hasOwn(fieldKinds,properties.kind) ? fieldKinds[properties.kind] : 'Объект OpenStreetMap';
        const name = properties.name || type;
        const detail = [properties.name && type,...fieldFacts(properties),'OpenStreetMap'].filter(Boolean).join(' · ');
        visit({name,detail,center,kind:'feature',informationOnly:true});
      },
      onError() {
        if (revision !== mapRevision) return;
        mapFailed = true;
        if (el('map-loading').hidden) setNotice('Часть карты не прочиталась. Проверь архивы в «Безопасности».',true);
        else el('map-loading').textContent = 'Карта не открылась. Попробуй перезагрузить приложение.';
        safety.render();
      },
    });
    map.map?.on('dragstart', event => {
      if (event.originalEvent && position) position.follow = false;
    });
  } catch {
    mapFailed = true;
    el('map-loading').textContent = 'Для карты нужен Safari или другой браузер с WebGL.';
  }
}

function normalized(text) {
  return text.trim().toLowerCase().replaceAll('ё','е').replace(/[\s.]+/g,' ');
}

function enteredCoordinates(query) {
  const match = query.trim().match(/^(?:WGS\s*84\s+)?(-?\d{1,2}\.\d+)\s*[,;]\s*(-?\d{1,3}\.\d+)(?:\s*·[^\n]*)?$/i);
  return match ? [Number(match[2]),Number(match[1])] : null;
}

function parkingZoom(place) {
  if (place.kind === 'building') return Math.max(17.5,map?.map.getZoom() || 0);
  if (!cachedArchive && !layerPanel.hasDetail()) return Math.min(10.7, data.previewZoom + 2.5);
  return ['street','address','pin','feature'].includes(place.kind) ? 16 : 13;
}

function inRegion(x,y) {
  return inAdministrativeRegion(geography?.boundary,x,y);
}

function inMapBounds(x,y) {
  if (!data?.region) return false;
  const [west,south,east,north] = data.region.bounds;
  return x >= west && x <= east && y >= south && y <= north;
}

function visit(place) {
  if (!(inRegion(...place.center) || (!geography && inMapBounds(...place.center)))) {
    setNotice('Выбери финиш в пределах Мурманской области.',true);
    return;
  }
  trackPanel.stopReturn();
  safety.stopGuide();
  setNotice();
  focusPlace = place;
  if (position) position.follow = false;
  el('map-title').textContent = place.name;
  search.blur();
  sheet(false);
  map?.visit(place.center, parkingZoom(place));
  navigation.select(place);
}

async function renderPlaces() {
  const current = ++searchRevision;
  const query = search.value;
  const q = normalized(query);
  const point = enteredCoordinates(query);
  const explicitAddress = !point && hasHouseNumber(query);
  el('clear-search').hidden = !search.value;
  library.dataset.search = String(Boolean(q));
  el('list-heading').textContent = q ? 'Результаты поиска' : 'Быстрый переход';
  if (!data) return;
  const empty = el('empty');
  if (point) {
    showPlaces(inRegion(...point) ? [{
      name:'Точка по координатам',detail:point.slice().reverse().join(', '),kind:'pin',center:point,
    }] : []);
    empty.textContent = 'Координаты за пределами Мурманской области.';
    return;
  }
  const privateMatches = q ? [...fieldPanel.search(query),...forestry.search(query,12)].slice(0,16) : [];
  if (explicitAddress) {
    const ref = value => normalized(value || '').replace(/[‑–—]/g,'-');
    const referenced = indexedPlaces.filter(({place}) => place.tags?.ref && ref(place.tags.ref) === ref(q))
      .slice(0,8).map(({place}) => place);
    const local = [...privateMatches,...referenced];
    showPlaces(local);
    empty.textContent = navigationArchive ? 'Ищем адрес на устройстве…' : 'Скачай навигацию, чтобы искать номера домов.';
    if (!navigationArchive) return;
    try {
      const matches = await navigation.lookup(query);
      if (current !== searchRevision) return;
      showPlaces([...local,...matches].slice(0,24));
      empty.textContent = 'Номер дома не найден. Укажи финиш на карте.';
    } catch {
      if (current === searchRevision) empty.textContent = 'Не удалось прочитать адресный справочник.';
    }
    return;
  }
  const terms = q.split(' ');
  const places = q ? indexedPlaces
    .filter(({keywords}) => terms.every(term => keywords.includes(term)))
    .sort((a,b) => Number(b.title === q) - Number(a.title === q) ||
      Number(b.title.startsWith(q)) - Number(a.title.startsWith(q)))
    .slice(0,24).map(({place}) => place) :
    data.places.filter(point => point.featured);
  showPlaces([...privateMatches,...places].slice(0,24));
  empty.textContent = 'Ничего не найдено. Попробуй название без сокращений или укажи финиш на карте.';
}

function showPlaces(places) {
  results.replaceChildren(...places.map(place => {
    const li = document.createElement('li');
    li.className = 'city-row';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'city-label';
    const thumb = document.createElement('span');
    thumb.className = 'city-thumb';
    thumb.setAttribute('aria-hidden','true');
    const icon = document.createElement('span');
    icon.className = 'icon icon-map';
    thumb.append(icon);
    const label = document.createElement('span');
    label.className = 'city-text';
    const name = document.createElement('strong');
    name.textContent = place.name;
    const detail = document.createElement('small');
    detail.textContent = place.detail;
    label.append(name,detail);
    button.append(thumb,label);
    button.addEventListener('click',() => {
      if (place.fieldId) fieldPanel.select(place.fieldId);
      else if (place.kind === 'forestry') {
        if (position) position.follow = false;
        if (forestry.showResult(place)) { search.blur(); sheet(false); }
      } else if (place.tags && (place.kind === 'street' || place.kind === 'feature')) {
        visit({...place,detail:[place.detail,...fieldFacts(place.tags),'OpenStreetMap'].filter(Boolean).join(' · ')});
      } else visit(place);
    });
    li.append(button);
    return li;
  }));
  el('empty').hidden = Boolean(places.length);
}

function setShellNotice(message = '', canRetry = true) {
  el('shell-status').textContent = message;
  el('retry-shell').hidden = !canRetry;
  el('shell-notice').hidden = !message;
  library.dataset.shellError = String(Boolean(message));
}

async function readShellController() {
  if (offlineReady || !workers?.controller) return;
  const names = await caches.keys().catch(() => []);
  const installed = names.find(name => name.startsWith('quiet-shell-'));
  clearTimeout(shellTimer);
  if (!installed) {
    setShellNotice('Файлы офлайн-запуска отсутствуют в хранилище браузера. Повтори подготовку с интернетом.');
    return;
  }
  shellVersion = installed;
  offlineReady = true;
  setShellNotice();
  renderDownload();
}

async function prepareShell() {
  if (offlineReady || registeringShell) return;
  if (!workers || !window.isSecureContext) {
    setShellNotice('Офлайн-режим недоступен в этом окне. Открой адрес сайта в Safari или Chrome.', false);
    return;
  }
  registeringShell = true;
  clearTimeout(shellTimer);
  setShellNotice();
  shellTimer = setTimeout(() => {
    if (!offlineReady) setShellNotice(navigator.onLine
      ? 'Подготовка офлайн-режима продолжается. Оставь приложение открытым.'
      : 'Для завершения подготовки офлайн-режима подключись к интернету.');
  },35000);
  try {
    const registration = await workers.register('/sw.js', {updateViaCache:'none'});
    const installing = registration.installing;
    if (installing) {
      function reportFailure() {
        if (!['redundant','activated'].includes(installing.state)) return;
        installing.removeEventListener('statechange', reportFailure);
        if (installing.state === 'redundant' && !workers.controller) {
          clearTimeout(shellTimer);
          setShellNotice('Не удалось сохранить файлы офлайн-запуска. Повтори подготовку.');
        }
      }
      installing.addEventListener('statechange', reportFailure);
      reportFailure();
    }
    await readShellController();
  } catch (error) {
    clearTimeout(shellTimer);
    if (offlineReady) return;
    const blocked = error.name === 'SecurityError' || error.name === 'NotAllowedError';
    setShellNotice(blocked
      ? 'Браузер запретил сохранение приложения. Открой адрес сайта в Safari или Chrome и повтори подготовку.'
      : navigator.onLine ? 'Не удалось подготовить офлайн-режим. Повтори подготовку.'
        : 'Подключись к интернету и повтори подготовку офлайн-режима.');
  } finally {
    registeringShell = false;
  }
}

async function beginDownload(walking = false, requireDetail = true) {
  const storage = mapStorage;
  const parts = pendingParts(walking);
  if (!storage || !data || !offlineReady || download || removingDownload || layerPanel.isBusy() ||
      (requireDetail && !layerPanel.vectorState().available && !layerPanel.vectorState().ready) ||
      (walking && !walkingData) || !parts.length) return;
  if (!navigator.onLine) {
    setNotice('Сначала подключись к интернету. После загрузки карта будет работать без сети.', true);
    return;
  }
  const current = new AbortController();
  download = {controller:current,walking,parts,expected:parts.reduce((sum,part) => sum + part.manifest.bytes,0)};
  el('pause-download').disabled = false;
  setNotice();
  renderDownload();
  if (navigator.storage?.persist) void navigator.storage.persist().catch(() => {});
  try {
    await checkStorage(download.expected - parts.reduce((sum,part) => sum + part.saved(),0));
    for (const part of parts) {
      const savedArchive = await storage.saveArchive(part.manifest, {
        signal:current.signal,
        onProgress(bytes) {
          part.progress(bytes);
          renderDownload();
        },
      });
      current.signal.throwIfAborted();
      part.installed(savedArchive);
    }
    setNotice(!layerPanel.vectorState().ready ? 'Файлы сохранены. Полная детализация ещё не скачана.' :
      walking ? 'Карта и пешие маршруты доступны офлайн.' :
      navigationArchive ? 'Карта и маршруты теперь доступны офлайн.' : 'Карта сохранена на устройстве.');
    storageFailed = false;
  } catch (error) {
    if (storage !== mapStorage) return;
    setNotice(current.signal.aborted ? 'Загрузка на паузе. Скачанные части сохранены.' : error.message, !current.signal.aborted);
    await Promise.all(parts.map(async part => {
      const bytes = await storage.progressOnDisk(part.manifest).catch(() => 0);
      if (storage === mapStorage) part.progress(bytes);
    }));
  } finally {
    download = null;
    renderDownload();
    void renderPlaces();
  }
}

el('download-region').addEventListener('click', () => {
  if (portraitPhone.matches) {
    sheet(true,'offline');
    mapPanel.scrollTop = 0;
  }
  void beginDownload();
});
el('enable-navigation').addEventListener('click', () => void beginDownload(navigation.mode() === 'walk',false));
el('pause-download').addEventListener('click', () => {
  el('pause-download').disabled = true;
  download?.controller.abort();
});
el('delete-region').addEventListener('click', () => el('delete-dialog').showModal());
el('confirm-delete').addEventListener('click', async () => {
  el('delete-dialog').close();
  const storage = mapStorage;
  if (!storage || download || removingDownload || layerPanel.isBusy()) return;
  removingDownload = true;
  renderDownload();
  try {
    await storage.removeArchive(data || 'map');
    if (storage !== mapStorage) return;
    cachedArchive = null;
    cachedManifest = null;
    diskBytes = 0;
    await layerPanel.clearVector();
    if (storage !== mapStorage) return;
    if (navigationData || navigationArchive) {
      await storage.removeArchive(navigationData || 'navigation');
      if (storage !== mapStorage) return;
      navigationArchive = null;
      navigationManifest = null;
      navigationBytes = 0;
    }
    if (walkingData || walkingArchive) {
      await storage.removeArchive(walkingData || 'walking');
      if (storage !== mapStorage) return;
      walkingArchive = null;
      walkingManifest = null;
      walkingBytes = 0;
    }
    setNotice('Скачанная карта удалена с устройства.');
  } catch {
    if (storage === mapStorage) setNotice('Не удалось удалить карту. Попробуй ещё раз.', true);
  } finally {
    removingDownload = false;
    if (!cachedArchive) {
      navigation.clear();
      if (privacy.isUnlocked()) drawMap();
    }
    renderDownload();
    void renderPlaces();
  }
});
el('sheet-toggle').addEventListener('click', () => {
  const expanded = library.dataset.expanded !== 'true';
  if (!expanded) search.blur();
  sheet(expanded);
});
el('offline-panel').addEventListener('click', () => {
  const expanded = el('offline-panel').getAttribute('aria-expanded') !== 'true';
  search.blur();
  sheet(expanded,'offline');
  if (expanded) mapPanel.scrollTop = 0;
});
el('retry-shell').addEventListener('click', () => void prepareShell());
el('clear-search').addEventListener('click', () => { search.value = ''; void renderPlaces(); search.focus(); });
search.addEventListener('input', () => { void renderPlaces(); sheet(true); });
search.addEventListener('focus', () => {
  sheet(true);
  mapPanel.scrollTop = 0;
  positionSearchAboveKeyboard();
});
search.addEventListener('blur', positionSearchAboveKeyboard);
visibleViewport?.addEventListener('resize', positionSearchAboveKeyboard);
visibleViewport?.addEventListener('scroll', positionSearchAboveKeyboard);
search.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  const first = results.querySelector('button');
  if (first && normalized(search.value)) first.click();
  else search.blur();
});
el('zoom-in').addEventListener('click', () => map?.zoomBy(1));
el('zoom-out').addEventListener('click', () => map?.zoomBy(-1));
el('map-north').addEventListener('click',() => map?.map.resetNorth({duration:180}));
el('fit-region').addEventListener('click', () => {
  if (trackPanel.showOverview()) return;
  if (navigation.showOverview()) return;
  if (position) position.follow = false;
  focusPlace = null;
  el('map-title').textContent = 'Мурманская область';
  map?.fit();
});
el('my-position').addEventListener('click', togglePosition);
el('vault-link').addEventListener('click', event => {
  if (offlineReady) return;
  event.preventDefault();
  sheet(true,'offline');
  setNotice('Сейф откроется, когда приложение подготовит файлы для офлайн-работы.');
});
function clearPrivateSession() {
  lastFix = undefined;
  stopPosition();
  navigation.hide();
  focusPlace = undefined;
  search.value = '';
  searchRevision += 1;
  results.replaceChildren();
  sheet(false);
  setNotice();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
}
document.addEventListener('visibilitychange', () => { if (document.hidden) privacy.lock(); });
window.addEventListener('pagehide', privacy.lock);
window.addEventListener('online', updateConnection);
window.addEventListener('offline', updateConnection);
el('about').addEventListener('click', () => el('help-dialog').showModal());
el('install').addEventListener('click', () => el('help-dialog').showModal());
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click',() => button.closest('dialog').close()));
new ResizeObserver(() => map?.resize()).observe(mapCanvas);

updateConnection();
renderDownload();
workers?.addEventListener('controllerchange', () => void readShellController());
if (workers?.controller) void readShellController();
else void prepareShell();

function buildSearchIndex() {
  const byTitle = new Map();
  indexedPlaces = [];
  for (const place of [...(data?.places || []),...(geography?.places || [])]) {
    const title = normalized(place.name);
    const key = place.kind + '|' + title;
    const existing = byTitle.get(key) || [];
    if (existing.some(old => Math.hypot(
      (old.center[0] - place.center[0])*0.38,old.center[1] - place.center[1]) < .001)) continue;
    existing.push(place);
    byTitle.set(key,existing);
    const keywords = normalized(place.name + ' ' + (place.detail || '') + ' ' + (place.alias || ''));
    indexedPlaces.push({place,title,keywords});
  }
}

async function openPackage(storage,kind,target) {
  try {
    const installed = await storage.openInstalledArchive(target || kind);
    const bytes = target ? atVersion(target,installed?.manifest) ? target.bytes : await storage.progressOnDisk(target) :
      installed?.manifest.bytes || 0;
    return {installed,bytes,failed:false};
  } catch {
    return {installed:null,bytes:0,failed:true};
  }
}

async function loadMaps(key) {
  const storage = createMapStorage(key);
  mapStorage = storage;
  el('map-loading').hidden = false;
  el('map-loading').textContent = 'Открываем карту…';
  try {
    const [region,overview,carData,walkData,boundary] = await Promise.all([
      regionInfo().catch(() => null),
      fetch('/data/preview.pmtiles', {redirect:'error'}).then(response => {
        return response.ok ? response.blob() : null;
      }).catch(() => null),
      navigationInfo().catch(() => null),
      walkingInfo().catch(() => null),
      fetch('/data/field-geography.json',{redirect:'error'}).then(response => response.ok ? response.json() : null).catch(() => null),
    ]);
    if (storage !== mapStorage) return;
    const [base,car,walk] = await Promise.all([
      openPackage(storage,'map',region),openPackage(storage,'navigation',carData),openPackage(storage,'walking',walkData),
    ]);
    if (storage !== mapStorage) return;
    cachedArchive = base.installed?.archive;
    cachedManifest = base.installed?.manifest;
    navigationArchive = car.installed?.archive;
    navigationManifest = car.installed?.manifest;
    walkingArchive = walk.installed?.archive;
    walkingManifest = walk.installed?.manifest;
    diskBytes = base.bytes;
    navigationBytes = car.bytes;
    walkingBytes = walk.bytes;
    data = region || cachedManifest;
    preview = overview;
    navigationData = carData;
    walkingData = walkData;
    geography = boundary;
    storageFailed = base.failed || car.failed || walk.failed;
    if (storageFailed) setNotice('Часть защищённых пакетов не открылась. Проверь свободное место и снова открой карты.',true);
    if (!geography) setNotice('Граница области и расширенный указатель недоступны. Запись новых мест приостановлена.',true);
    if (!data) {
      mapFailed = true;
      el('map-loading').textContent = 'Не удалось прочитать описание региона. Открой приложение с интернетом.';
    }
    buildSearchIndex();
    void renderPlaces();
    renderDownload();
    if (data) drawMap();
    await layerPanel.load(storage);
  } catch {
    if (storage === mapStorage) el('map-loading').textContent = 'Не удалось открыть карту.';
  }
}
