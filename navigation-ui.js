import {createNavigationClient} from './navigation-client.js';
import {routeProgress} from './routing-engine.js';

const id = value => document.getElementById(value);
const glyphs = {
  depart:'↑', straight:'↑', left:'←', right:'→',
  'slight-left':'↖', 'slight-right':'↗', 'u-turn':'↶', roundabout:'⟲', arrive:'■',
};
const number = new Intl.NumberFormat('ru-RU', {maximumFractionDigits:1});
const WALK_FIX_AGE = 12000;
const WALK_FIX_ACCURACY = 25;
const WALK_OFFSET_NOTICE = 10;

function meters(value) {
  if (value >= 1000) return number.format(value / 1000) + ' км';
  return Math.max(0,Math.round(value / 5) * 5) + ' м';
}

function usableFix(fix,now,maxAge,maxAccuracy) {
  return fix && Number.isFinite(fix.lng) && Number.isFinite(fix.lat) &&
    Number.isFinite(fix.timestamp) && Math.abs(now - fix.timestamp) <= maxAge &&
    Number.isFinite(fix.accuracy) && fix.accuracy >= 0 && fix.accuracy <= maxAccuracy;
}

function distanceToPoint(fix,endpoint) {
  const [lng,lat] = endpoint;
  const x = (fix.lng - lng) * Math.cos(lat * Math.PI / 180);
  return Math.hypot(x,fix.lat - lat) * 111132;
}

export function isAtArrival(fix,endpoint,now = Date.now(),profile = 'car') {
  const walking = profile === 'walk';
  if (!usableFix(fix,now,walking ? 5000 : 8000,walking ? 12 : 30)) return false;
  if (walking && fix.timestamp > now + 1000) return false;
  const distance = distanceToPoint(fix,endpoint);
  return walking ? distance <= 12 && distance + fix.accuracy <= 20 : distance <= 27;
}

const routeErrors = {
  'no-start-road':'Рядом с твоей точкой нет дороги для автомобиля.',
  'no-goal-road':'К этой точке не найден автомобильный подъезд.',
  'no-route':'Между этими точками нет доступного автомобильного маршрута на скачанной карте.',
  'invalid-point':'Выбери точку в пределах Мурманской области.',
};
const walkingErrors = {
  'no-start-road':'Рядом с твоей точкой на скачанной карте нет пешеходного пути.',
  'no-goal-road':'Рядом с финишем на скачанной карте нет пешеходного пути.',
  'no-route':'Между этими точками на скачанной карте нет доступного пешеходного маршрута.',
};

function features(route,destination) {
  const list = [];
  if (route?.coordinates.length >= 2) list.push({
    type:'Feature', properties:{kind:'line',profile:route.profile},
    geometry:{type:'LineString',coordinates:route.coordinates},
  });
  if (route?.profile === 'walk') {
    for (const point of [route.snapStart,route.snapEnd]) list.push({
      type:'Feature', properties:{kind:'walk-endpoint'},
      geometry:{type:'Point',coordinates:point},
    });
  }
  if (destination) list.push({
    type:'Feature', properties:{kind:'destination'},
    geometry:{type:'Point',coordinates:destination.center},
  });
  return {type:'FeatureCollection',features:list};
}

function attachLayers(map) {
  if (map.getSource('quiet-directions')) return;
  map.addSource('quiet-directions', {type:'geojson',data:features()});
  const line = (name,color,width) => ({
    id:name, type:'line', source:'quiet-directions',
    filter:['==',['geometry-type'],'LineString'],
    layout:{'line-cap':'round','line-join':'round'},
    paint:{'line-color':color,'line-width':width},
  });
  map.addLayer(line('quiet-directions-casing','#fff',10));
  map.addLayer(line('quiet-directions-line',['case',['==',['get','profile'],'walk'],'#087c71','#245cdb'],6));
  map.addLayer({
    id:'quiet-walk-endpoint', type:'circle', source:'quiet-directions',
    filter:['==',['get','kind'],'walk-endpoint'],
    paint:{'circle-radius':5,'circle-color':'#087c71','circle-stroke-color':'white','circle-stroke-width':2},
  });
  map.addLayer({
    id:'quiet-destination', type:'circle', source:'quiet-directions',
    filter:['==',['get','kind'],'destination'],
    paint:{'circle-radius':8,'circle-color':'#d44645','circle-stroke-color':'white','circle-stroke-width':2.5},
  });
}

function fitRoute(map,route,destination) {
  const [startX,startY] = route.coordinates[0];
  const bounds = [[startX,startY],[startX,startY]];
  const points = route.profile === 'walk' ? [...route.coordinates,destination.center] : route.coordinates;
  for (const [x,y] of points) {
    bounds[0][0] = Math.min(bounds[0][0], x);
    bounds[0][1] = Math.min(bounds[0][1], y);
    bounds[1][0] = Math.max(bounds[1][0], x);
    bounds[1][1] = Math.max(bounds[1][1], y);
  }
  const width = map.getContainer().clientWidth;
  const height = map.getContainer().clientHeight;
  map.fitBounds(bounds,{
    padding:{top:Math.min(66,height*.25),bottom:Math.min(40,height*.19),left:25,right:Math.min(63,width/5)},
    maxZoom:route.profile === 'walk' ? 16.8 : 15.5,
    duration:390,
  });
}

export function createNavigationUI({getFix,requestGps,followGps,onSelect,onClear,onModeChange,canPickFromMap = () => true}) {
  const card = id('destination-card');
  const summary = id('route-summary');
  const build = id('build-route');
  const start = id('start-guidance');
  const stop = id('stop-guidance');
  const stepList = id('route-steps');
  const turn = id('turn-banner');
  const routeStatus = id('route-status');
  const selectionHint = id('pin-hint');
  const install = id('enable-navigation');
  const carMode = id('route-mode-car');
  const walkMode = id('route-mode-walk');
  const profileNote = id('route-profile-note');
  const routeKind = id('route-kind');
  const packs = {car:{},walk:{}};
  let map;
  let pickHandler;
  let picking = false;
  let profile = 'car';
  let destination;
  let route;
  let guiding = false;
  let arrivalShown = false;
  let awaitingFix = false;
  let fixTimer;
  let inFlight = false;
  let revision = 0;
  let segment = 0;
  let offRouteCount = 0;
  let lastReroute = 0;
  let walkJoined = false;
  let walkDistance = 0;
  let walkMatchedTime;
  let walkFixTime = -Infinity;
  let walkFixTimer;
  let wakeLock;

  function status(text = '',error = false) {
    routeStatus.textContent = text;
    routeStatus.hidden = !text;
    routeStatus.dataset.error = String(error);
  }

  function render() {
    const walking = profile === 'walk';
    const installed = packs[profile].ready;
    const informationOnly = Boolean(destination?.informationOnly);
    card.hidden = !destination;
    const library = document.querySelector('.library');
    library.dataset.destination = String(Boolean(destination));
    library.dataset.route = String(Boolean(route));
    const workspace = document.querySelector('.workspace');
    workspace.dataset.route = String(Boolean(route));
    workspace.dataset.guiding = String(guiding);
    const overview = route ? 'Показать весь маршрут' : 'Показать всю область';
    id('fit-region').setAttribute('aria-label', overview);
    id('fit-region').title = overview;
    id('destination-name').textContent = destination?.name || '';
    id('destination-detail').textContent = destination?.detail || '';
    carMode?.setAttribute('aria-pressed',String(!walking));
    walkMode?.setAttribute('aria-pressed',String(walking));
    if (carMode?.parentElement) carMode.parentElement.hidden = informationOnly;
    install.hidden = installed || informationOnly;
    install.textContent = walking ? 'Скачать пешеходные маршруты' : 'Скачать навигацию';
    build.hidden = !installed || Boolean(route) || informationOnly;
    build.disabled = inFlight || awaitingFix;
    if (inFlight) build.textContent = 'Строим маршрут…';
    else if (awaitingFix) build.textContent = 'Ждём GPS…';
    else build.textContent = walking ? 'Маршрут пешком от меня' : 'Маршрут от меня';
    summary.hidden = !route;
    if (routeKind) routeKind.textContent = walking ? 'Пешком' : 'На машине · без учёта пробок';
    if (profileNote) {
      profileNote.hidden = !route || !walking;
      profileNote.textContent = route?.usesUncertain ?
        'Время приблизительное. На маршруте есть участки с неуточнённым доступом или сложным покрытием.' :
        'Время пешком приблизительное.';
    }
    start.hidden = !route || guiding;
    start.textContent = walking ? 'Начать путь' : 'Начать поездку';
    stop.hidden = !guiding;
    stop.textContent = walking ? 'Завершить маршрут' : 'Завершить поездку';
    turn.hidden = !guiding;
    selectionHint.hidden = !picking;
    id('pick-destination').setAttribute('aria-pressed',String(picking));
  }

  function paint() {
    map?.getSource('quiet-directions')?.setData(features(route,destination));
  }

  function setPicking(active) {
    picking = active;
    if (map) map.getCanvas().style.cursor = active ? 'crosshair' : '';
    render();
  }

  function setMap(next) {
    if (next === map) return;
    if (pickHandler) map?.off('click',pickHandler);
    map = next;
    pickHandler = undefined;
    if (!map) return;
    attachLayers(map);
    paint();
    pickHandler = ({lngLat}) => {
      if (!picking || !canPickFromMap()) return;
      setPicking(false);
      onSelect({name:'Точка на карте',detail:'Мурманская область',center:[lngLat.lng,lngLat.lat],kind:'pin'});
    };
    map.on('click',pickHandler);
    map.getCanvas().style.cursor = picking ? 'crosshair' : '';
  }

  function releaseWakeLock() {
    wakeLock?.release().catch(() => {});
    wakeLock = undefined;
  }

  function endFixWait() {
    clearTimeout(fixTimer);
    awaitingFix = false;
  }

  function resetWalkingProgress() {
    clearTimeout(walkFixTimer);
    walkJoined = false;
    walkDistance = 0;
    walkMatchedTime = undefined;
    walkFixTime = -Infinity;
  }

  function clear({keepDestination = false} = {}) {
    ++revision;
    releaseWakeLock();
    followGps(false);
    route = undefined;
    guiding = false;
    arrivalShown = false;
    endFixWait();
    inFlight = false;
    segment = 0;
    offRouteCount = 0;
    lastReroute = 0;
    resetWalkingProgress();
    if (!keepDestination) {
      destination = undefined;
      onClear();
    }
    setPicking(false);
    status();
    stepList.replaceChildren();
    render();
    paint();
  }

  function disposeClient(pack) {
    pack.client?.dispose();
    pack.client = undefined;
  }

  function useProfileArchive(forProfile,archive,ready) {
    const pack = packs[forProfile];
    const changed = archive !== pack.archive;
    if (changed) {
      disposeClient(pack);
      pack.archive = archive;
    }
    pack.ready = Boolean(archive && ready);
    if (forProfile === profile && (changed || !pack.ready) && (route || inFlight || awaitingFix)) {
      clear({keepDestination:true});
    } else render();
  }

  function setMode(next) {
    if (next === profile) return;
    if (profile === 'walk') disposeClient(packs.walk);
    profile = next;
    clear({keepDestination:true});
    onModeChange?.(profile);
  }

  function offlineEngine(forProfile) {
    const pack = packs[forProfile];
    pack.client ??= createNavigationClient(pack.archive,forProfile);
    return pack.client;
  }

  async function lookup(query) {
    if (!packs.car.archive) return [];
    return offlineEngine('car').search(query);
  }

  function select(place) {
    clear({keepDestination:true});
    destination = place;
    render();
    paint();
  }

  function renderDirections(result) {
    const minutes = Math.max(1,Math.round(result.seconds/60));
    const duration = minutes < 60 ? minutes + ' мин' :
      Math.floor(minutes/60) + ' ч' + (minutes%60 ? ' ' + (minutes%60) + ' мин' : '');
    id('route-duration').textContent = duration;
    id('route-distance').textContent = meters(result.distance);
    const approach = id('route-approach');
    const offsets = [];
    const walking = result.profile === 'walk';
    if (walking && result.snapStartDistance >= WALK_OFFSET_NOTICE) {
      offsets.push(`От твоей точки до начала маршрута по прямой ${meters(result.snapStartDistance)}.`);
    }
    if (result.snapEndDistance >= (walking ? WALK_OFFSET_NOTICE : 50)) {
      offsets.push(`От конца маршрута до отмеченной точки по прямой ${meters(result.snapEndDistance)}.`);
    }
    approach.hidden = !offsets.length;
    approach.textContent = offsets.join(' ');
    stepList.replaceChildren(...result.steps.map(step => {
      const row = document.createElement('li');
      const icon = document.createElement('span');
      icon.setAttribute('aria-hidden','true');
      icon.textContent = glyphs[step.type] || '•';
      const line = document.createElement('span');
      line.textContent = step.label;
      row.append(icon,line);
      return row;
    }));
  }

  async function calculate(fix,recalculate = false) {
    if (!destination || !packs[profile].ready || inFlight) return;
    const operation = ++revision;
    const goal = destination.center;
    inFlight = true;
    endFixWait();
    status(recalculate ? 'Перестраиваем маршрут…' : 'Строим маршрут на устройстве…');
    render();
    try {
      const result = await offlineEngine(profile).route([fix.lng,fix.lat],goal);
      if (operation !== revision) return;
      route = result;
      segment = 0;
      offRouteCount = 0;
      resetWalkingProgress();
      status();
      renderDirections(result);
      paint();
      if (guiding) {
        const walking = profile === 'walk';
        if (walking) inFlight = false;
        showProgress(walking ? getFix() : fix);
      } else if (map) {
        render();
        map.resize();
        fitRoute(map,result,destination);
      }
    } catch (error) {
      if (operation !== revision) return;
      if (recalculate) clear({keepDestination:true});
      const walking = profile === 'walk';
      const message = (walking && walkingErrors[error.code]) || routeErrors[error.code] || (walking ?
        'Не удалось построить пешеходный маршрут.' :
        'Не удалось построить маршрут. Попробуй выбрать точку рядом с дорогой.');
      status(message,true);
    } finally {
      if (operation === revision) {
        inFlight = false;
        render();
      }
    }
  }

  function goodFix(fix,now = Date.now()) {
    if (profile === 'walk') {
      return usableFix(fix,now,WALK_FIX_AGE,WALK_FIX_ACCURACY) && fix.timestamp <= now + 1000;
    }
    return usableFix(fix,now,30000,170);
  }

  function buildRoute() {
    if (!destination || !packs[profile].ready || inFlight || awaitingFix) return;
    followGps(false);
    const fix = getFix();
    if (goodFix(fix)) void calculate(fix);
    else {
      awaitingFix = true;
      status('Ждём достаточно точный сигнал GPS.');
      render();
      fixTimer = setTimeout(() => gpsIssue('Точный сигнал GPS пока недоступен. Попробуй построить маршрут ещё раз.'),24000);
      requestGps();
    }
  }

  function setTurn(glyph,label,detail) {
    id('turn-glyph').textContent = glyph;
    id('turn-label').textContent = label;
    id('turn-distance').textContent = detail;
  }

  function finishGuidance() {
    arrivalShown = true;
    clearTimeout(walkFixTimer);
    releaseWakeLock();
    followGps(false);
  }

  function waitForWalkingFix() {
    clearTimeout(walkFixTimer);
    offRouteCount = 0;
    setTurn('·','Ждём точный сигнал GPS…','');
  }

  function showWalkingProgress(fix) {
    const now = Date.now();
    if (!goodFix(fix,now)) {
      waitForWalkingFix();
      return;
    }
    if (fix.timestamp <= walkFixTime) return;
    walkFixTime = fix.timestamp;
    clearTimeout(walkFixTimer);
    walkFixTimer = setTimeout(waitForWalkingFix, fix.timestamp + WALK_FIX_AGE - now + 1);

    if (inFlight) {
      setTurn('·','Перестраиваем пешеходный маршрут…','');
      return;
    }
    if (!walkJoined) {
      const startDistance = distanceToPoint(fix,route.snapStart);
      if (startDistance > 14 || startDistance + fix.accuracy > 33) {
        setTurn('·','Начало маршрута на карте',`До начала по прямой около ${meters(startDistance)}`);
        return;
      }
      walkJoined = true;
      walkMatchedTime = fix.timestamp;
    }

    const progress = routeProgress(route,[fix.lng,fix.lat],segment,walkDistance,{
      elapsed:fix.timestamp - walkMatchedTime, accuracy:fix.accuracy,
    });
    if (!progress) return;
    if (progress.ambiguous) {
      offRouteCount = 0;
      setTurn('·','Уточняем положение на маршруте','Сверь своё место с картой');
      return;
    }
    const tolerance = Math.max(12,Math.min(18,fix.accuracy));
    if (progress.distanceFromRoute > tolerance) {
      const definitelyOffRoute = fix.accuracy <= 18 && progress.distanceFromRoute > Math.max(25,fix.accuracy * 1.65);
      offRouteCount = definitelyOffRoute ? offRouteCount + 1 : 0;
      if (offRouteCount >= 3 && now - lastReroute > 15000) {
        lastReroute = now;
        setTurn('·','Перестраиваем пешеходный маршрут…','');
        void calculate(fix,true);
      } else setTurn('·','Сверь своё место с маршрутом','');
      return;
    }

    segment = progress.coordinateIndex;
    walkDistance = progress.distanceFromStart;
    walkMatchedTime = fix.timestamp;
    offRouteCount = 0;
    if (progress.remainingDistance <= 12 && isAtArrival(fix,route.snapEnd,now,'walk')) {
      const offset = route.snapEndDistance;
      const atTarget = offset < WALK_OFFSET_NOTICE && isAtArrival(fix,destination.center,now,'walk');
      setTurn(glyphs.arrive, atTarget ? 'Ты у места назначения' : 'Ты у конца пешеходного маршрута',
        offset >= WALK_OFFSET_NOTICE ? `До отмеченной точки по прямой ${meters(offset)}` : 'Пешеходный маршрут завершён');
      finishGuidance();
      return;
    }

    const step = progress.nextStep;
    if (step && step.type !== 'arrive') {
      setTurn(glyphs[step.type] || '↑',step.label,
        `${meters(progress.distanceToNextStep)} до поворота · ${meters(progress.remainingDistance)} осталось`);
    } else setTurn('↑','Продолжай по маршруту',`${meters(progress.remainingDistance)} до конца маршрута`);
  }

  function showProgress(fix) {
    if (profile === 'walk') {
      showWalkingProgress(fix);
      return;
    }
    if (!goodFix(fix)) {
      id('turn-distance').textContent = 'Ждём точный сигнал GPS…';
      return;
    }
    const progress = routeProgress(route,[fix.lng,fix.lat],segment);
    if (!progress) return;
    const tolerance = Math.max(65, (fix.accuracy || 0) * 1.65);
    const onRoute = progress.distanceFromRoute <= tolerance;
    if (onRoute) {
      segment = progress.coordinateIndex;
      offRouteCount = 0;
    } else if (!inFlight) {
      ++offRouteCount;
      if (offRouteCount >= 2 && Date.now() - lastReroute > 9000) {
        lastReroute = Date.now();
        void calculate(fix,true);
      }
    }
    const step = progress.nextStep;
    const arrived = progress.remainingDistance <= 30 && isAtArrival(fix,route.snapEnd);
    id('turn-glyph').textContent = arrived ? glyphs.arrive : step?.type === 'arrive' ? '↑' : glyphs[step?.type] || '↑';
    id('turn-label').textContent = arrived ? 'Ты у места назначения' :
      step?.type === 'arrive' ? 'Продолжай до финиша' : step?.label || 'Продолжай по маршруту';
    id('turn-distance').textContent = arrived ? 'Маршрут завершён' :
      inFlight && !onRoute ? 'Перестраиваем…' :
      step && step.type !== 'arrive' ? meters(progress.distanceToNextStep) + ' до манёвра · ' +
        meters(progress.remainingDistance) + ' осталось' : meters(progress.remainingDistance) + ' до финиша';
    if (arrived) finishGuidance();
  }

  function updateFix(fix) {
    if (awaitingFix && goodFix(fix)) void calculate(fix);
    if (guiding && route && !arrivalShown) showProgress(fix);
  }

  function unavailable(message) {
    if (awaitingFix || guiding) {
      clear({keepDestination:true});
      status(message || 'Геопозиция отключена.');
    }
  }

  function gpsIssue(message) {
    if (awaitingFix) {
      endFixWait();
      status(message,true);
      render();
    } else if (guiding && !arrivalShown) {
      if (profile === 'walk') waitForWalkingFix();
      else id('turn-distance').textContent = 'Ждём сигнал GPS…';
    }
  }

  function hide() {
    clear();
    disposeClient(packs.car);
    disposeClient(packs.walk);
  }

  function showOverview() {
    if (!map || !route) return false;
    followGps(false);
    fitRoute(map,route,destination);
    return true;
  }

  async function startGuidance() {
    if (!route || guiding) return;
    const operation = revision;
    const walking = profile === 'walk';
    guiding = true;
    segment = 0;
    followGps(true);
    let fix = getFix();
    if (!fix || (walking && !goodFix(fix))) {
      requestGps();
      if (!guiding) return;
      followGps(true);
      fix = getFix();
    }
    if (fix && (!walking || goodFix(fix))) {
      map?.easeTo({center:[fix.lng,fix.lat],zoom:walking ? 17 : 15.6,duration:320});
    }
    if (fix || walking) showProgress(fix);
    render();
    if (navigator.wakeLock) {
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (operation !== revision || !guiding || arrivalShown || document.hidden) await lock.release();
        else wakeLock = lock;
      } catch { /* Guidance also works without screen wake lock. */ }
    }
  }

  build.addEventListener('click',buildRoute);
  start.addEventListener('click',() => void startGuidance());
  stop.addEventListener('click',() => clear({keepDestination:true}));
  id('close-destination').addEventListener('click',() => clear());
  id('pick-destination').addEventListener('click',() => { if (canPickFromMap()) setPicking(!picking); });
  carMode?.addEventListener('click',() => setMode('car'));
  walkMode?.addEventListener('click',() => setMode('walk'));

  return {
    setMap, lookup, select, clear, updateFix, unavailable, gpsIssue, hide, showOverview,
    cancelPicking:() => { if (picking) setPicking(false); },
    mode:() => profile,
    useArchive:(archive,ready) => useProfileArchive('car',archive,ready),
    useWalkingArchive:(archive,ready) => useProfileArchive('walk',archive,ready),
  };
}
