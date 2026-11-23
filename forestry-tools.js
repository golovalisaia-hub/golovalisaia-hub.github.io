import {
  forestryText, MAX_FORESTRY_FILE_BYTES, MAX_FORESTRY_LAYERS, MAX_FORESTRY_VERTICES,
  MAX_MEASUREMENT_POINTS, MAX_MEASUREMENTS, measurementBounds, measureShape,
  parseForestryLayer, searchForestryLayers,
} from './forestry-core.js';
import {openForestryStore} from './forestry-store.js';

const number = new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1});
const hectares = new Intl.NumberFormat('ru-RU',{maximumFractionDigits:3});
const errors = {
  format:'Не удалось прочитать GeoJSON. Выбери файл с одним или несколькими объектами.',
  geometry:'В файле есть некорректная или неподдерживаемая геометрия.',
  coordinates:'В файле есть недопустимые координаты. Экспортируй его в WGS 84.',
  crs:'Файл использует другую систему координат. Экспортируй его в GeoJSON WGS 84.',
  limit:'Слой слишком большой. Раздели данные на части или убери старый слой.',
  changed:'Список изменился в другой вкладке. Повтори действие.',
  'measurement-limit':'В журнале 100 измерений. Удали ненужные, чтобы добавить новое.',
};

const importSource = 'quiet-forestry';
const measurementSource = 'quiet-measurement';
const measurementVertices = 'quiet-measurement-vertices';
const polygons = ['==',['geometry-type'],'Polygon'];
const lines = ['in',['geometry-type'],['literal',['Polygon','LineString']]];
const points = ['==',['geometry-type'],'Point'];

const importLayers = [
  {id:'quiet-forestry-fill',type:'fill',filter:polygons,paint:{'fill-color':'#7755aa','fill-opacity':0.24}},
  {id:'quiet-forestry-edge-light',type:'line',filter:lines,paint:{'line-width':3.8,'line-color':'#fffdf5'}},
  {id:'quiet-forestry-edge',type:'line',filter:lines,paint:{'line-width':2,'line-color':'#624594'}},
  {id:'quiet-forestry-points',type:'circle',filter:points,paint:{
    'circle-radius':6,'circle-stroke-width':2,'circle-stroke-color':'#fffdf5','circle-color':'#624594',
  }},
];

const measurementLayers = [
  {id:'quiet-measurement-fill',type:'fill',filter:polygons,paint:{'fill-color':'#0b9d8d','fill-opacity':0.27}},
  {id:'quiet-measurement-edge-light',type:'line',filter:lines,paint:{'line-width':5,'line-color':'#fffdf5'}},
  {id:'quiet-measurement-edge',type:'line',filter:lines,paint:{'line-width':2.8,'line-color':'#037267'}},
  {id:measurementVertices,type:'circle',filter:points,paint:{
    'circle-radius':7,'circle-stroke-width':2,'circle-stroke-color':'#fffdf5',
    'circle-color':['case',['==',['get','selected'],true],'#a45413','#037267'],
  }},
];

function node(tag,{text,className,id} = {}) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  if (id) element.id = id;
  return element;
}

function button(label,onClick,className = 'forestry-button') {
  const element = node('button',{text:label,className});
  element.type = 'button';
  element.addEventListener('click',onClick);
  return element;
}

function drawSource(map,id,layers,features) {
  if (!map) return;
  if (!features.length) {
    for (const {id:layer} of layers) if (map.getLayer(layer)) map.removeLayer(layer);
    if (map.getSource(id)) map.removeSource(id);
    return;
  }
  const data = {type:'FeatureCollection',features};
  const source = map.getSource(id);
  if (source) { source.setData(data); return; }
  map.addSource(id,{type:'geojson',data});
  for (const layer of layers) map.addLayer({...layer,source:id});
}

const measurementTitle = mode => mode === 'area' ? 'Площадь' : 'Расстояние';

function summary(mode,value) {
  if (!value.valid) {
    if (value.issue === 'intersection') return 'Контур пересекает себя. Перемести или убери вершину.';
    return mode === 'area' ? 'Добавь хотя бы три вершины контура.' : 'Добавь начальную и конечную точки.';
  }
  return mode === 'area' ? number.format(value.squareMetres) + ' м² · ' +
    hectares.format(value.squareMetres/10_000) + ' га' : number.format(value.metres) + ' м';
}

function makeMeasurementFeatures(shape,value) {
  if (!shape) return [];
  const {mode,points,selected} = shape;
  const features = points.map((position,index) => ({
    type:'Feature',geometry:{type:'Point',coordinates:position},properties:{selected:index === selected},
  }));
  if (points.length > 1) {
    const geometry = mode === 'area' && value.valid ?
      {type:'Polygon',coordinates:[[...points,points[0]]]} : {type:'LineString',coordinates:points};
    features.push({type:'Feature',geometry,properties:{}});
  }
  return features;
}

export function createForestryTools({mapArea,trigger,canMeasure=() => true,onStartDraw=() => {},onChange=() => {}}) {
  let map;
  let store;
  let authorized = false;
  let records = [];
  let revision = 0;
  let busy = false;
  const hiddenLayers = new Set();
  let draft;
  let displayed;

  const dialog = node('dialog',{id:'forestry-dialog',className:'forestry-dialog'});
  const title = node('h2',{id:'forestry-title',text:'Лес и измерения'});
  dialog.setAttribute('aria-labelledby',title.id);
  const heading = node('header',{className:'dialog-title'});
  const close = button('×',() => dialog.close(),'icon-button');
  close.setAttribute('aria-label','Закрыть');
  heading.append(title,close);

  const layerList = node('ul',{className:'forestry-records',id:'forestry-layer-list'});
  const measurementList = node('ul',{className:'forestry-records',id:'forestry-measurement-list'});
  const importer = node('section',{className:'forestry-section'});
  const file = node('input',{id:'forestry-file'});
  file.type = 'file';
  file.accept = '.geojson,.json,application/geo+json,application/json';
  file.hidden = true;
  const importButton = button('Импорт GeoJSON',() => file.click());
  importer.append(node('h3',{text:'Лесные слои'}),importButton,file,
    node('p',{text:'WGS 84 · до 5 МиБ на файл. Слои хранятся на устройстве.',className:'forestry-note'}),layerList);

  const tools = node('section',{className:'forestry-section'});
  const startRow = node('div',{className:'forestry-buttons'});
  const lengthButton = button('Измерить расстояние',() => start('distance'));
  const areaButton = button('Измерить площадь',() => start('area'));
  const savePane = node('div',{className:'forestry-save-pane'});
  const saveReading = node('p');
  const name = node('input',{className:'forestry-name',id:'forestry-measurement-name'});
  name.type = 'text';
  name.autocomplete = 'off';
  name.maxLength = 100;
  const nameLabel = node('label',{text:'Название измерения'});
  nameLabel.htmlFor = name.id;
  const save = button('Сохранить измерение',saveDraft);
  const resume = button('Продолжить разметку',() => dialog.close());
  const clear = button('Убрать с карты',() => { displayed = null; render(); });
  const saveActions = node('div',{className:'forestry-buttons'});
  const status = node('p',{className:'forestry-status',id:'forestry-status'});
  status.setAttribute('role','status');
  saveActions.append(save,resume);
  savePane.append(saveReading,nameLabel,name,saveActions);
  startRow.append(lengthButton,areaButton);
  tools.append(node('h3',{text:'Измерения по карте'}),startRow,
    node('p',{text:'Горизонтальная оценка по карте. Для точной съёмки нужны полевые измерения.',className:'forestry-note'}),
    savePane,clear,measurementList);
  dialog.append(heading,importer,tools,status);
  document.body.append(dialog);

  const drawPanel = node('section',{className:'forestry-draw',id:'forestry-draw'});
  const drawTitle = node('strong');
  const reading = node('p',{id:'forestry-reading'});
  reading.setAttribute('role','status');
  const controls = node('div',{className:'forestry-buttons'});
  const erase = button('Убрать точку',removePoint);
  const finish = button('Завершить',() => {
    if (!draft || !measureShape(draft.mode,draft.points).valid) return;
    draft.review = true;
    render();
    dialog.showModal();
    name.focus();
  });
  const cancel = button('Отмена',() => { draft = null; name.value = ''; render(); });
  controls.append(erase,finish,cancel);
  drawPanel.append(drawTitle,reading,controls);
  mapArea.append(drawPanel);
  trigger.setAttribute('aria-haspopup','dialog');
  trigger.setAttribute('aria-controls',dialog.id);
  trigger.addEventListener('click',() => {
    if (authorized) dialog.showModal();
  });
  dialog.addEventListener('close',() => {
    if (draft?.review) { draft.review = false; render(); }
  });
  file.addEventListener('change',() => {
    const selected = file.files[0];
    file.value = '';
    if (selected) void addFile(selected);
  });

  function showStatus(message = '') {
    status.hidden = !message;
    status.textContent = message;
  }

  function paintImports() {
    const features = records.flatMap(({id,value}) => value?.kind === 'layer' && !hiddenLayers.has(id) ?
      value.data.features.map(feature => ({...feature,id:id + ':' + feature.id})) : []);
    drawSource(map,importSource,importLayers,features);
  }

  function showExtent(bounds) {
    if (!map) return false;
    const [west,south,east,north] = bounds;
    onStartDraw();
    if (west === east && south === north) map.easeTo({center:[west,south],zoom:16,duration:250});
    else map.fitBounds(bounds,{padding:35,maxZoom:17,duration:250});
    if (dialog.open) dialog.close();
    return true;
  }

  function showResult(place) {
    if (!store || !map || !place?.bounds || !records.some(({id}) => id === place.layerId)) return false;
    if (hiddenLayers.delete(place.layerId)) {
      paintImports();
      renderLists();
    }
    return showExtent(place.bounds);
  }

  async function removeRecord(id) {
    const removed = await mutate(async db => {
      await db.remove(id);
      return db.list();
    },'Удалено с устройства.');
    if (removed && displayed?.id === id) { displayed = null; render(); }
  }

  function recordRow(record) {
    const {id,value,damaged} = record;
    const row = node('li');
    const content = node('span',{className:'forestry-record-name'});
    content.append(node('span',{text:damaged ? 'Повреждённый файл' : value.name}));
    row.append(content);
    if (value?.kind === 'layer') {
      const visibility = node('input');
      visibility.type = 'checkbox';
      visibility.checked = !hiddenLayers.has(id);
      visibility.setAttribute('aria-label','Показывать слой ' + value.name);
      visibility.addEventListener('change',() => {
        if (visibility.checked) hiddenLayers.delete(id);
        else hiddenLayers.add(id);
        paintImports();
      });
      row.prepend(visibility);
      row.append(button('К слою',() => showResult({layerId:id,bounds:value.bounds})));
    } else if (value?.kind === 'measurement') {
      content.append(node('small',{text:summary(value.mode,measureShape(value.mode,value.points))}));
      row.append(button('На карте',() => {
        draft = null;
        name.value = '';
        displayed = {id,...value};
        render();
        showExtent(measurementBounds(value.points));
      }));
    }
    const remove = button('Удалить',() => {
      if (remove.dataset.confirm === 'true') { void removeRecord(id); return; }
      remove.dataset.confirm = 'true';
      remove.textContent = 'Подтвердить';
    });
    row.append(remove);
    return row;
  }

  function renderLists() {
    layerList.replaceChildren(...records.filter(({value,damaged}) => damaged || value?.kind === 'layer').map(recordRow));
    measurementList.replaceChildren(...records.filter(({value}) => value?.kind === 'measurement').map(recordRow));
  }

  function render(message) {
    trigger.disabled = !authorized;
    file.disabled = importButton.disabled = !store || busy;
    lengthButton.disabled = areaButton.disabled = !store || !map || busy;
    clear.hidden = !displayed;
    savePane.hidden = !draft?.review;
    drawPanel.hidden = !draft || draft.review;
    mapArea.classList.toggle('forestry-drawing',!drawPanel.hidden);
    const shape = draft ?? displayed;
    const value = shape && measureShape(shape.mode,shape.points);
    drawSource(map,measurementSource,measurementLayers,makeMeasurementFeatures(shape,value));
    if (!draft) {
      drawTitle.textContent = reading.textContent = saveReading.textContent = '';
      return;
    }
    const measurement = summary(draft.mode,value);
    drawTitle.textContent = measurementTitle(draft.mode);
    reading.textContent = message || (draft.selected !== null ?
      'Нажми на новое место или удали выбранную точку.' : measurement);
    saveReading.textContent = measurement;
    erase.disabled = !draft.points.length;
    erase.textContent = draft.selected === null ? 'Убрать точку' : 'Удалить точку';
    finish.disabled = !value.valid;
    save.disabled = !value.valid || busy;
  }

  function start(mode) {
    if (!map || !store || busy) return;
    onStartDraw();
    name.value = '';
    displayed = null;
    draft = {mode,points:[],selected:null,review:false};
    dialog.close();
    render(mode === 'area' ? 'Нажимай на карте, чтобы обвести участок.' :
      'Нажимай на карте, чтобы поставить точки.');
  }

  function removePoint() {
    if (!draft || draft.review || !draft.points.length) return;
    draft.points.splice(draft.selected ?? draft.points.length-1,1);
    draft.selected = null;
    render();
  }

  function addPoint(event) {
    if (!draft || draft.review) return;
    const coords = [event.lngLat.lng,event.lngLat.lat];
    let index = -1;
    let closest = 11;
    // Source rendering is asynchronous. Match the current draft rather than a previous rendered frame.
    for (const [candidate,coordinate] of draft.points.entries()) {
      const projected = map.project(coordinate);
      const distance = Math.hypot(projected.x-event.point.x,projected.y-event.point.y);
      if (distance < closest) { closest = distance; index = candidate; }
    }
    if (index !== -1) {
      draft.selected = draft.selected === index ? null : index;
    } else if (!canMeasure(coords)) {
      render('Точка за пределами Мурманской области.');
      return;
    } else if (draft.selected !== null) {
      draft.points[draft.selected] = coords;
      draft.selected = null;
    } else if (draft.points.length < MAX_MEASUREMENT_POINTS) {
      draft.points.push(coords);
    } else {
      render('Достигнут предел в 128 точек.');
      return;
    }
    render();
  }

  async function mutate(action,message) {
    const active = store;
    if (!active || busy) return false;
    const session = revision;
    busy = true;
    showStatus();
    render();
    try {
      const next = await action(active);
      if (session !== revision) return false;
      records = next;
      paintImports();
      renderLists();
      showStatus(message);
      onChange();
      return true;
    } catch (error) {
      if (session !== revision) return false;
      if (error.code === 'changed') {
        const updated = await active.list().catch(() => null);
        if (session !== revision) return false;
        if (updated) {
          records = updated;
          paintImports();
          renderLists();
          onChange();
        }
      }
      showStatus(errors[error.code] || (error.name === 'QuotaExceededError' ?
        'На устройстве закончилось место.' : 'Не удалось сохранить данные на устройстве.'));
      return false;
    } finally {
      if (session === revision) { busy = false; render(); }
    }
  }

  async function addFile(selected) {
    if (selected.size > MAX_FORESTRY_FILE_BYTES) {
      showStatus('Файл больше 5 МиБ. Раздели слой на части.');
      return;
    }
    const session = revision;
    await mutate(async db => {
      const content = await selected.text();
      if (session !== revision) return records;
      const value = parseForestryLayer(content,selected.name);
      const loaded = records.filter(({value}) => value?.kind === 'layer');
      const vertices = loaded.reduce((sum,{value}) => sum+value.vertices,0);
      if (loaded.length >= MAX_FORESTRY_LAYERS || vertices+value.vertices > MAX_FORESTRY_VERTICES) {
        throw Object.assign(new Error('limit'),{code:'limit'});
      }
      return [...records,await db.add(value,records.map(({id}) => id))];
    },'Лесной слой сохранён на устройстве.');
  }

  async function saveDraft() {
    if (!draft?.review) return;
    const current = draft;
    const measurement = measureShape(draft.mode,draft.points);
    if (!measurement.valid) return;
    const value = {
      kind:'measurement',mode:draft.mode,points:draft.points.map(point => point.slice()),
      name:forestryText(name.value) || measurementTitle(draft.mode) + ' · ' + summary(draft.mode,measurement),
      createdAt:Date.now(),
    };
    if (await mutate(async db => {
      if (records.filter(({value}) => value?.kind === 'measurement').length >= MAX_MEASUREMENTS) {
        throw Object.assign(new Error('measurement-limit'),{code:'measurement-limit'});
      }
      return [...records,await db.add(value,records.map(({id}) => id))];
    },'Измерение сохранено.') && current === draft) {
      draft = null;
      displayed = {id:records.at(-1).id,...value};
      name.value = '';
      render();
    }
  }

  function setMap(next) {
    if (map === next) return;
    if (map) {
      map.off('click',addPoint);
      drawSource(map,importSource,importLayers,[]);
      drawSource(map,measurementSource,measurementLayers,[]);
    }
    map = next;
    map?.on('click',addPoint);
    paintImports();
    render();
  }

  render();
  showStatus();
  return {
    setMap,
    isDrawing:() => Boolean(draft && !draft.review),
    search:(query,limit) => searchForestryLayers(records,query,limit),
    showResult,
    async unlock(key) {
      const session = ++revision;
      authorized = true;
      let opened;
      try {
        opened = await openForestryStore(key);
        const saved = await opened.list();
        if (session !== revision) { opened.close(); return; }
        store = opened;
        records = saved;
        paintImports();
        renderLists();
        onChange();
      } catch {
        opened?.close();
        if (session === revision) showStatus('Не удалось открыть зашифрованные лесные данные.');
      } finally {
        if (session === revision) render();
      }
    },
    lock() {
      revision += 1;
      authorized = false;
      busy = false;
      store?.close();
      store = undefined;
      records = [];
      hiddenLayers.clear();
      draft = displayed = null;
      name.value = file.value = '';
      if (dialog.open) dialog.close();
      showStatus();
      setMap(null);
      renderLists();
      render();
      onChange();
    },
  };
}
