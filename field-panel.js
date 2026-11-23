import {FIELD_PHOTO_MAX_BYTES,openFieldRecords} from './field-security.js';
import {trackFixIssue} from './track-geometry.js';
import {fieldCategories,savedPoint,searchFieldPoints,trackGpx,validTime,waypointGeoJson,waypointGpx} from './field-journal-data.js';

const el = id => document.getElementById(id);
const day = new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
const exactDate = new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short'});
const accuracyText = new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1});
const MAX_SAVE_ACCURACY = 45;
const photoLimitMiB = FIELD_PHOTO_MAX_BYTES / 1024 ** 2;
const mapSource = 'quiet-saved-points';
const anchorMessages = {car:'Место машины сохранено.',start:'Точка старта сохранена.'};

function element(tag,text = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function button(label,onClick,className = 'inline-button',id) {
  const node = element('button',label);
  node.type = 'button';
  node.className = className;
  if (id) node.id = id;
  node.addEventListener('click',onClick);
  return node;
}

function formLabel(name,control) {
  const label = element('label',name);
  label.append(control);
  return label;
}

const coordinates = point => point.lat.toFixed(5) + ', ' + point.lng.toFixed(5);

function pointDetails(point) {
  const timestamp = point.timestamp ?? point.createdAt;
  return [
    coordinates(point),
    point.accuracy !== null && '±' + accuracyText.format(point.accuracy) + ' м',
    timestamp && exactDate.format(timestamp),
  ].filter(Boolean).join(' · ');
}

export function createFieldPanel({getFix,requestGps,canSave,getTrack,showTrack,selectPlace,onChange,onBearing,canPickFromMap = () => true}) {
  let store;
  let records = [];
  let points = [];
  let pointIndex = new Map();
  let selectedId = null;
  let map;
  let revision = 0;
  let previewRequest = 0;
  let photoUrl;
  let busy = false;
  let failed = false;
  let editing;
  const downloadUrls = new Map();
  const dialog = el('track-dialog');
  const journal = el('field-journal');
  const name = el('field-name');
  const note = el('field-note');
  const nameLabel = name.closest('label');
  const noteLabel = note.closest('label');
  const save = el('field-save');
  const list = el('field-saved');
  const notice = el('field-status');
  const description = element('textarea');
  description.id = 'field-description';
  description.maxLength = 400;
  description.rows = 2;
  const category = element('select');
  category.id = 'field-category';
  for (const [key,label] of fieldCategories) {
    const option = element('option',label);
    option.value = key;
    category.append(option);
  }
  category.value = 'other';
  const categoryLabel = formLabel('Категория',category);
  const descriptionLabel = formLabel('Описание',description);
  const photo = element('input');
  photo.id = 'field-photo';
  photo.type = 'file';
  photo.accept = 'image/jpeg,image/png,image/webp';
  const photoLabel = formLabel('Фото до ' + photoLimitMiB + ' МиБ · JPEG, PNG или WebP',photo);
  const erasePhoto = element('input');
  erasePhoto.type = 'checkbox';
  const erasePhotoLabel = formLabel('Удалить фото',erasePhoto);
  erasePhotoLabel.className = 'field-checkbox';
  const preview = element('div');
  preview.id = 'field-photo-preview';
  preview.hidden = true;
  const photoMessage = element('p');
  photoMessage.className = 'track-privacy';
  photoMessage.setAttribute('role','status');
  photoMessage.hidden = true;
  nameLabel.before(categoryLabel);
  noteLabel.before(descriptionLabel);
  noteLabel.after(photoLabel,erasePhotoLabel);
  list.after(photoMessage,preview);
  photo.addEventListener('change',() => { if (photo.files.length) erasePhoto.checked = false; });

  const quick = element('section');
  quick.className = 'track-session field-anchors';
  const quickButtons = element('div');
  quickButtons.className = 'field-buttons';
  const car = button('Запомнить машину',() => void saveAnchor('car'),'layer-download','field-quick-car');
  const start = button('Запомнить точку старта',() => void saveAnchor('start'),'layer-download','field-start');
  const goCar = button('Вернуться к машине',() => guide('car'),'inline-button','field-return-car');
  const goStart = button('Вернуться к старту',() => guide('start'),'inline-button','field-return-start');
  const add = button('Добавить точку',() => {
    resetForm();
    journal.open = true;
    name.focus();
  },'inline-button','field-add-point');
  quickButtons.append(car,start,goCar,goStart,add);
  const quickStatus = element('p');
  quickStatus.setAttribute('role','status');
  quickStatus.hidden = true;
  quick.append(element('h3','Полевые точки'),quickButtons,quickStatus);
  journal.before(quick);

  const controls = save.parentElement;
  const browse = button('Отмена',resetForm,'inline-button','field-cancel-edit');
  const pointsGpx = button('Точки в GPX',() => {
    if (points.length) downloadFile(waypointGpx(points),'application/gpx+xml','tikhie-karty-tochki.gpx');
  },'inline-button');
  const pointsGeo = button('Точки в GeoJSON',() => {
    if (points.length) downloadFile(waypointGeoJson(points),'application/geo+json','tikhie-karty-tochki.geojson');
  },'inline-button');
  controls.append(browse,pointsGpx,pointsGeo);
  journal.querySelector('.track-privacy').textContent = 'В GPX и GeoJSON координаты и заметки открыты. Фото остаются в журнале.';

  const getPoint = id => pointIndex.get(id) ?? null;
  const loadRecords = db => db.list({includeDamaged:true,includeVersion:true});
  const currentFix = () => {
    const fix = getFix();
    return !trackFixIssue(fix,Date.now(),MAX_SAVE_ACCURACY) && canSave(fix) ? fix : null;
  };
  const activeTrack = () => {
    const track = getTrack();
    return track?.segments.some(section => section.length) ? track : null;
  };

  function snapshot() {
    return {
      ready:Boolean(store),failed,car:getPoint('car'),start:getPoint('start'),selected:getPoint(selectedId),
      waypointCount:points.length,trackCount:records.filter(record => record.value?.kind === 'trip').length,
    };
  }

  function status(value = '',target = notice) {
    target.hidden = !value;
    target.textContent = value;
  }

  function render() {
    const allowed = Boolean(store && !busy);
    const fix = currentFix();
    const editTrip = editing?.value.kind === 'trip';
    const editAnchor = editing?.id === 'car' || editing?.id === 'start';
    const fields = [categoryLabel,descriptionLabel,noteLabel,photoLabel];
    for (const label of fields) label.hidden = editTrip;
    erasePhotoLabel.hidden = !editing?.value.photoRef || editTrip;
    for (const control of [name,note,description,photo,erasePhoto]) control.disabled = !allowed;
    category.disabled = !allowed || editAnchor;
    browse.hidden = !editing;
    browse.disabled = !allowed;
    save.disabled = !allowed || (!editing && !fix);
    save.textContent = editing ? 'Сохранить изменения' : 'Сохранить место';
    el('field-gps').hidden = Boolean(fix || editing);
    el('field-gps').disabled = !allowed;
    el('field-car').hidden = Boolean(editing);
    el('field-car').disabled = !allowed || !fix;
    el('field-archive').disabled = !allowed || !activeTrack();
    el('field-export').disabled = !allowed || !activeTrack();
    pointsGpx.disabled = pointsGeo.disabled = !allowed || !points.length;
    car.disabled = start.disabled = add.disabled = !allowed;
    goCar.hidden = !getPoint('car') || !onBearing;
    goStart.hidden = !getPoint('start') || !onBearing;
  }

  function resetForm() {
    editing = undefined;
    name.value = description.value = note.value = photo.value = '';
    erasePhoto.checked = false;
    category.value = 'other';
    render();
  }

  function clickMarker(event) {
    if (!canPickFromMap()) return;
    const id = event.features?.[0]?.properties?.fieldId;
    if (typeof id === 'string') select(id);
  }

  function paint() {
    if (!map) return;
    const data = {type:'FeatureCollection',features:points.map(point => ({
      type:'Feature',id:point.id,properties:{
        fieldId:point.id,category:point.category,
        label:point.id === 'car' ? 'М' : point.id === 'start' ? 'С' : '',
      },
      geometry:{type:'Point',coordinates:[point.lng,point.lat]},
    }))};
    const source = map.getSource(mapSource);
    if (source) { source.setData(data); return; }
    map.addSource(mapSource,{type:'geojson',data});
    map.addLayer({
      id:mapSource,type:'circle',source:mapSource,
      paint:{
        'circle-radius':['match',['get','category'],['car','start'],10,6],
        'circle-stroke-width':2,'circle-stroke-color':'#fff',
        'circle-color':['match',['get','category'],'car','#3655a3','start','#00665d',
          ['hazard','obstruction','fallen-tree'],'#a63923','#8c591d'],
      },
    });
    map.addLayer({
      id:'quiet-saved-anchor-labels',type:'symbol',source:mapSource,
      filter:['!=',['get','label'],''],
      layout:{'text-field':['get','label'],'text-font':['Arial Bold','Arial'],'text-size':13,'text-allow-overlap':true},
      paint:{'text-color':'#fff'},
    });
    map.on('click',mapSource,clickMarker);
  }

  function select(id) {
    const point = getPoint(id);
    if (!point) return false;
    selectedId = id;
    if (dialog.open) dialog.close();
    selectPlace({
      name:point.name,detail:point.description || pointDetails(point),center:[point.lng,point.lat],kind:'pin',fieldId:id,
    });
    onChange?.(snapshot());
    return true;
  }

  function guide(id) {
    const point = getPoint(id);
    if (!point || !onBearing) return false;
    selectedId = id;
    if (dialog.open) dialog.close();
    onBearing(point);
    onChange?.(snapshot());
    return true;
  }

  function closePreview() {
    previewRequest += 1;
    preview.replaceChildren();
    preview.hidden = true;
    status('',photoMessage);
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = undefined;
  }

  async function showPhoto(id) {
    closePreview();
    const access = revision;
    const request = previewRequest;
    try {
      const blob = await store.getPhoto(id);
      if (access !== revision || request !== previewRequest || !dialog.open) return;
      if (!blob) throw new Error('photo-missing');
      const image = element('img');
      image.alt = 'Фотография наблюдения';
      image.addEventListener('error',() => {
        if (access === revision && request === previewRequest) {
          closePreview();
          status('Не удалось показать фото.',photoMessage);
        }
      });
      photoUrl = URL.createObjectURL(blob);
      image.src = photoUrl;
      preview.append(image,button('Закрыть фото',closePreview));
      preview.hidden = false;
      preview.scrollIntoView({block:'nearest'});
    } catch {
      if (access === revision && request === previewRequest) status('Не удалось открыть фото.',photoMessage);
    }
  }

  function downloadFile(data,type,filename) {
    if (!store) return;
    const link = element('a');
    const url = URL.createObjectURL(new Blob([data],{type}));
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    downloadUrls.set(url,setTimeout(() => {
      URL.revokeObjectURL(url);
      downloadUrls.delete(url);
    },10000));
  }

  function exportTrack(track,title) {
    const date = validTime(track.createdAt) ? '-' + new Date(track.createdAt).toISOString().slice(0,10) : '';
    downloadFile(trackGpx(track,title),'application/gpx+xml','tikhie-karty' + date + '.gpx');
  }

  function editRecord(record) {
    if (!store || busy) return;
    editing = record;
    const {id,value} = record;
    name.value = value.name || '';
    description.value = value.description || '';
    note.value = value.note || '';
    category.value = getPoint(id)?.category ?? 'other';
    erasePhoto.checked = false;
    photo.value = '';
    status();
    render();
    name.focus();
  }

  function changeList() {
    points = records.map(({id,value}) => savedPoint(id,value)).filter(Boolean);
    pointIndex = new Map(points.map(point => [point.id,point]));
    if (!getPoint(selectedId)) selectedId = null;
    const nodes = records.filter(({id,value,damaged}) => damaged || getPoint(id) || value?.kind === 'trip')
      .map(record => {
        const {id,value,damaged,version} = record;
        const point = getPoint(id);
        const title = point?.name ?? value?.name ?? 'Повреждённая запись';
        const row = element('li');
        row.className = 'field-row';
        const view = button(title,() => point ? select(id) : showTrack(value.track));
        view.className = 'field-row-title';
        view.disabled = Boolean(damaged);
        row.append(view);
        if (point) {
          const info = element('p',fieldCategories.get(point.category) + ' · ' + pointDetails(point));
          info.className = 'field-row-detail';
          row.append(info);
          for (const text of [point.description,point.note]) {
            if (text) row.append(element('p',text));
          }
        }
        const tools = element('div');
        tools.className = 'field-row-tools';
        if (!damaged) tools.append(button('Изменить',() => editRecord(record)));
        if (point && onBearing && id !== 'car' && id !== 'start') tools.append(button('Направление',() => guide(id)));
        if (value?.photoRef) tools.append(button('Фото',() => void showPhoto(id)));
        if (value?.kind === 'trip') tools.append(button('GPX',() => exportTrack(value.track,value.name)));
        const remove = button('Удалить',() => {
          if (remove.dataset.confirm) void mutate(db => db.remove(id,{expectedVersion:version}),'Запись удалена.',notice,() => {
            if (editing?.id === id) resetForm();
            closePreview();
          });
          else { remove.dataset.confirm = 'true'; remove.textContent = 'Подтвердить удаление'; }
        },'layer-remove');
        tools.append(remove);
        row.append(tools);
        return row;
      });
    list.replaceChildren(...nodes);
    paint();
    onChange?.(snapshot());
  }

  async function mutate(action,message,target = notice,onSaved) {
    const db = store;
    if (!db || busy) return false;
    const access = revision;
    busy = true;
    render();
    try {
      await action(db);
      if (access !== revision) return false;
      const next = await loadRecords(db);
      if (access !== revision) return false;
      records = next;
      changeList();
      onSaved?.();
      status(message,target);
      return true;
    } catch (error) {
      if (access !== revision) return false;
      if (error?.code === 'record-changed') {
        const next = await loadRecords(db).catch(() => null);
        if (access !== revision) return false;
        if (next) { records = next; changeList(); }
        status('Запись изменилась в другой вкладке. Открой её снова для правки.',target);
        return false;
      }
      status({
        'photo-format':'Выбери настоящий файл JPEG, PNG или WebP.',
        'photo-size':'Выбери фото размером до ' + photoLimitMiB + ' МиБ.',
      }[error?.code] || (error?.name === 'QuotaExceededError' ?
        'На устройстве мало места. Запись не изменена.' : 'Не удалось изменить запись на устройстве.'),target);
      return false;
    } finally {
      if (access === revision) { busy = false; render(); }
    }
  }

  function saveAt(fix,id,pointCategory,target,useForm) {
    const existing = records.find(record => record.id === id);
    const previous = existing?.value;
    const value = {
      ...previous,kind:'point',category:pointCategory,lng:fix.lng,lat:fix.lat,accuracy:fix.accuracy,
      createdAt:Date.now(),timestamp:fix.timestamp,
      altitude:Number.isFinite(fix.altitude) ? fix.altitude : null,
      name:(useForm && name.value.trim()) || previous?.name || fieldCategories.get(pointCategory),
      note:useForm ? note.value.trim() : previous?.note || '',
      description:useForm ? description.value.trim() : previous?.description || '',
    };
    const files = useForm ? photo.files[0] : undefined;
    return mutate(db => db.put(id,value,{photo:files,expectedVersion:existing?.version ?? null}),
      anchorMessages[id] ?? 'Место сохранено.',target,
      useForm ? resetForm : undefined);
  }

  function saveAnchor(id,useForm = false) {
    if (!store || busy) return Promise.resolve(false);
    const fix = currentFix();
    const target = useForm ? notice : quickStatus;
    if (!fix) {
      requestGps();
      status('Дождись свежей позиции GPS с точностью до 45 м и нажми ещё раз.',target);
      return Promise.resolve(false);
    }
    return saveAt(fix,id,id,target,useForm);
  }

  function saveForm() {
    if (editing) {
      const {id,value,version} = editing;
      const next = {...value,name:name.value.trim() || value.name};
      if (value.kind === 'point') {
        next.category = getPoint(id)?.category;
        if (id !== 'car' && id !== 'start') next.category = category.value;
        next.description = description.value.trim();
        next.note = note.value.trim();
      }
      const files = photo.files[0] ?? (erasePhoto.checked ? null : undefined);
      return mutate(db => db.put(id,next,{photo:files,expectedVersion:version}),'Изменения сохранены.',notice,() => {
        closePreview();
        resetForm();
      });
    }
    const fix = currentFix();
    if (!fix) return false;
    const categoryId = category.value;
    const id = categoryId === 'car' || categoryId === 'start' ? categoryId : crypto.randomUUID();
    return saveAt(fix,id,categoryId,notice,true);
  }

  function archiveTrack(track) {
    if (!track?.segments.some(section => section.length)) return Promise.resolve(false);
    const id = 'trip-' + track.id;
    const saved = records.find(record => record.id === id);
    const title = validTime(track.createdAt) ? 'Трек · ' + day.format(track.createdAt) : 'Записанный трек';
    const value = {kind:'trip',name:saved?.value?.name || title,track};
    return mutate(db => db.put(id,value,{expectedVersion:saved?.version ?? null}),'Трек сохранён в журнале.');
  }

  dialog.addEventListener('close',closePreview);
  el('field-gps').addEventListener('click',requestGps);
  journal.addEventListener('toggle',render);
  save.addEventListener('click',() => void saveForm());
  el('field-car').addEventListener('click',() => void saveAnchor('car',true));
  el('field-archive').addEventListener('click',() => void archiveTrack(activeTrack()));
  el('field-export').addEventListener('click',() => {
    const track = activeTrack();
    if (track) exportTrack(track);
  });
  render();

  return {
    render,snapshot,select,guide,archiveTrack,
    saveCar:() => saveAnchor('car'),saveStart:() => saveAnchor('start'),
    search:query => searchFieldPoints(points,query),
    setMap(next) {
      if (map === next) return;
      map?.off('click',mapSource,clickMarker);
      map = next;
      paint();
    },
    async unlock(key) {
      const access = ++revision;
      let opened;
      failed = false;
      try {
        opened = await openFieldRecords(key);
        if (access !== revision) { opened.close(); return; }
        const saved = await loadRecords(opened);
        if (access !== revision) { opened.close(); return; }
        store = opened;
        records = saved;
        changeList();
        render();
      } catch {
        opened?.close();
        if (access === revision) {
          store = undefined;
          failed = true;
          records = [];
          changeList();
          render();
          status('Не удалось открыть зашифрованный журнал.');
        }
      }
    },
    lock() {
      revision += 1;
      store?.close();
      store = undefined;
      busy = false;
      failed = false;
      records = [];
      journal.open = false;
      resetForm();
      closePreview();
      for (const [url,timer] of downloadUrls) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      downloadUrls.clear();
      status();
      status('',quickStatus);
      changeList();
      render();
    },
  };
}
