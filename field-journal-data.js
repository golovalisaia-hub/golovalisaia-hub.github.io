export const fieldCategories = new Map([
  ['car','Машина'],
  ['start','Начало маршрута'],
  ['work','Место работы'],
  ['forest-road','Лесная дорога'],
  ['path','Тропа'],
  ['fallen-tree','Поваленное дерево'],
  ['obstruction','Завал'],
  ['hazard','Опасный участок'],
  ['crossing','Переправа'],
  ['bridge','Мост'],
  ['stream','Ручей'],
  ['lake','Озеро'],
  ['damage','Повреждённый лес'],
  ['other','Другое'],
]);

export function validCoordinates(point) {
  return Number.isFinite(point?.lng) && Math.abs(point.lng) <= 180 &&
    Number.isFinite(point.lat) && Math.abs(point.lat) <= 90;
}

export const validTime = time => Number.isFinite(time) && time > 0 && time <= 8640000000000000;

export function savedPoint(id,value) {
  if (value?.kind !== 'point' || !validCoordinates(value)) return null;
  const category = id === 'car' || id === 'start' ? id : fieldCategories.has(value.category) ? value.category : 'other';
  const text = (source, max) => typeof source === 'string' ? source.trim().slice(0,max) : '';
  return {
    id,category,
    name:text(value.name,70) || fieldCategories.get(category),
    note:text(value.note,800),
    description:text(value.description,400),
    lng:value.lng,lat:value.lat,
    accuracy:Number.isFinite(value.accuracy) && value.accuracy >= 0 ? value.accuracy : null,
    altitude:Number.isFinite(value.altitude) ? value.altitude : null,
    createdAt:validTime(value.createdAt) ? value.createdAt : null,
    timestamp:validTime(value.timestamp) ? value.timestamp : null,
  };
}

const searchText = value => value.toLocaleLowerCase('ru-RU').replaceAll('ё','е')
  .replace(/[^\p{L}\p{N}]+/gu,' ').trim();

export function searchFieldPoints(points,query) {
  if (typeof query !== 'string' || query.length > 160) return [];
  const terms = searchText(query).split(' ').filter(Boolean);
  if (!terms.length) return [];
  return points.filter(point => {
    const fields = searchText([point.name,fieldCategories.get(point.category),point.description,point.note].join(' '));
    return terms.every(term => fields.includes(term));
  }).slice(0,16).map(point => ({
    name:point.name,detail:'Моя точка · ' + fieldCategories.get(point.category),
    center:[point.lng,point.lat],kind:'pin',fieldId:point.id,
  }));
}

const xmlEscape = value => String(value)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/gu,'')
  .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
  .replaceAll('"','&quot;').replaceAll("'",'&apos;');
const tag = (name,value) => value == null || value === '' ? '' : '<' + name + '>' + xmlEscape(value) + '</' + name + '>';
const air = point => Number.isFinite(point.altitude) ? tag('ele',point.altitude) : '';
const time = timestamp => validTime(timestamp) ? tag('time',new Date(timestamp).toISOString()) : '';
const position = point => ' lat="' + point.lat + '" lon="' + point.lng + '">';

function extensions(point) {
  const accuracy = Number.isFinite(point.accuracy) && point.accuracy >= 0 ? tag('quiet:accuracy',point.accuracy) : '';
  const speed = Number.isFinite(point.speed) && point.speed >= 0 ? tag('quiet:speed',point.speed) : '';
  return accuracy || speed ? '<extensions>' + accuracy + speed + '</extensions>' : '';
}

function gpx(contents) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<gpx version="1.1" creator="Тихие карты" xmlns="http://www.topografix.com/GPX/1/1"' +
    ' xmlns:quiet="urn:quiet-maps:field:1">' + contents + '</gpx>';
}

export function waypointGpx(points) {
  return gpx(points.filter(validCoordinates).map(point => '<wpt' + position(point) + air(point) +
    time(point.timestamp ?? point.createdAt) + tag('name',point.name) +
    tag('desc',[point.description,point.note].filter(Boolean).join('\n')) +
    tag('type',fieldCategories.get(point.category)) + extensions(point) + '</wpt>').join(''));
}

export function trackGpx(track,name = 'Мой путь') {
  const segments = track.segments.filter(section => section.length).map(section => '<trkseg>' +
    section.filter(validCoordinates).map(fix => '<trkpt' + position(fix) + air(fix) +
      time(fix.timestamp) + extensions(fix) + '</trkpt>').join('') + '</trkseg>').join('');
  return gpx('<trk>' + tag('name',name) + segments + '</trk>');
}

export function waypointGeoJson(points) {
  return JSON.stringify({
    type:'FeatureCollection',
    features:points.filter(validCoordinates).map(point => ({
      type:'Feature',
      geometry:{type:'Point',coordinates:[point.lng,point.lat]},
      properties:{
        name:point.name,category:point.category,categoryLabel:fieldCategories.get(point.category),
        description:point.description,note:point.note,accuracyMeters:point.accuracy,
        observedAt:validTime(point.timestamp) ? new Date(point.timestamp).toISOString() : null,
        savedAt:validTime(point.createdAt) ? new Date(point.createdAt).toISOString() : null,
      },
    })),
  });
}
