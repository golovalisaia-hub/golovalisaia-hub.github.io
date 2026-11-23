import {trackDistance} from './track-geometry.js';

export const MAX_FORESTRY_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_FORESTRY_VERTICES = 150_000;
export const MAX_FORESTRY_LAYERS = 8;
export const MAX_MEASUREMENT_POINTS = 128;
export const MAX_MEASUREMENTS = 100;

const EARTH_RADIUS = 6371008.8;
const RADIANS = Math.PI / 180;
const MAX_FEATURES = 8000;
const WGS84_NAMES = new Set(['urn:ogc:def:crs:OGC:1.3:CRS84','OGC:CRS84',
  'urn:ogc:def:crs:OGC::CRS84','urn:ogc:def:crs:EPSG::4326','EPSG:4326',
  'http://www.opengis.net/def/crs/EPSG/0/4326']);

function error(code) { return Object.assign(new Error(code),{code}); }

function requireWgs84(value) {
  if (Object.hasOwn(value,'crs') && !WGS84_NAMES.has(value.crs?.properties?.name)) throw error('crs');
}

function position(value) {
  return Array.isArray(value) && (value.length === 2 || value.length === 3) &&
    value.every(Number.isFinite) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}

const samePoint = (a,b) => a[0] === b[0] && a[1] === b[1];
const emptyExtent = () => [Infinity,Infinity,-Infinity,-Infinity];

function extend(extent, lng, lat) {
  extent[0] = Math.min(extent[0],lng);
  extent[1] = Math.min(extent[1],lat);
  extent[2] = Math.max(extent[2],lng);
  extent[3] = Math.max(extent[3],lat);
}

export function measurementBounds(points) {
  const extent = emptyExtent();
  for (const [lng,lat] of points) extend(extent,lng,lat);
  return extent;
}

function requiredArray(values, minimum, read) {
  if (!Array.isArray(values) || values.length < minimum) throw error('geometry');
  return values.map(read);
}

function measureRing(coords) {
  const [lng,lat] = coords[0];
  let sum = 0;
  for (let index = 1; index < coords.length; index++) {
    const a = coords[index-1];
    const b = coords[index];
    sum += (a[0]-lng) * (b[1]-lat) - (b[0]-lng) * (a[1]-lat);
  }
  return sum;
}

function readGeometry(geometry, readPosition, depth = 0) {
  if (!geometry || depth > 2) throw error('geometry');
  requireWgs84(geometry);
  const line = (coords, minimum = 2) => requiredArray(coords,minimum,readPosition);
  const ring = coords => {
    const values = line(coords,4);
    if (!samePoint(values[0],values.at(-1)) || measureRing(values) === 0) throw error('geometry');
    return values;
  };
  const polygon = coords => requiredArray(coords,1,ring);
  const {type,coordinates} = geometry;
  switch (type) {
    case 'Point': return {type,coordinates:readPosition(coordinates)};
    case 'MultiPoint': return {type,coordinates:line(coordinates,1)};
    case 'LineString': return {type,coordinates:line(coordinates)};
    case 'MultiLineString': return {type,coordinates:requiredArray(coordinates,1,value => line(value))};
    case 'Polygon': return {type,coordinates:polygon(coordinates)};
    case 'MultiPolygon': return {type,coordinates:requiredArray(coordinates,1,polygon)};
    case 'GeometryCollection': return {type,geometries:requiredArray(geometry.geometries,1,
      value => readGeometry(value,readPosition,depth + 1))};
    default: throw error('geometry');
  }
}

export function forestryText(value, maxLength = 100) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,' ').trim().slice(0,maxLength);
}

function featureName(feature) {
  const fields = new Map(Object.entries(feature.properties ?? {}).map(([key,value]) => [key.toLowerCase(),value]));
  function get(...names) {
    for (const name of names) {
      const value = forestryText(fields.get(name));
      if (value) return value;
    }
    return '';
  }
  const label = get('name','name:ru','title','название','наименование','участок','worksite');
  const quarter = get('compartment','compartment_number','quarter','квартал','квартал_номер','номер_квартала');
  const stand = get('stand','stand_number','выдел','выдел_номер','номер_выдела');
  return forestryText([label,quarter && 'Квартал ' + quarter,stand && 'Выдел ' + stand]
    .filter(Boolean).join(' · ')) || forestryText(feature.id);
}

/** Reads the coordinates as declared in RFC 7946. Geometry from the file stays in WGS84. */
export function parseForestryLayer(text, filename) {
  let document;
  try { document = JSON.parse(text.replace(/^\uFEFF/u,'')); }
  catch { throw error('format'); }
  if (!document || typeof document !== 'object') throw error('format');
  requireWgs84(document);
  const features = document.type === 'FeatureCollection' ? document.features :
    document.type === 'Feature' ? [document] : null;
  if (!Array.isArray(features) || !features.length) throw error('format');
  if (features.length > MAX_FEATURES) throw error('limit');

  const bounds = emptyExtent();
  let vertices = 0;
  const verified = features.map((feature,index) => {
    if (feature?.type !== 'Feature') throw error('format');
    requireWgs84(feature);
    const bbox = emptyExtent();
    const geometry = readGeometry(feature.geometry,coordinates => {
      if (!position(coordinates)) throw error('coordinates');
      if (++vertices > MAX_FORESTRY_VERTICES) throw error('limit');
      extend(bbox,coordinates[0],coordinates[1]);
      return coordinates;
    });
    extend(bounds,bbox[0],bbox[1]);
    extend(bounds,bbox[2],bbox[3]);
    return {type:'Feature',id:index,geometry,bbox,properties:{name:featureName(feature)}};
  });

  const name = forestryText(filename?.replace(/\.(?:geojson|json)$/iu,'') || 'Лесной слой');
  return {kind:'layer',name:name || 'Лесной слой',createdAt:Date.now(),bounds,vertices,
    data:{type:'FeatureCollection',features:verified}};
}

const normalize = text => text.toLocaleLowerCase('ru-RU').replaceAll('ё','е').trim();

function searchResult(layerId, name, detail, bounds) {
  const [west,south,east,north] = bounds;
  return {kind:'forestry',layerId,name,detail,bounds,center:[(west+east)/2,(south+north)/2]};
}

export function searchForestryLayers(records, query, limit = 12) {
  const words = normalize(query).split(/\s+/u).filter(Boolean);
  if (!words.length || limit < 1) return [];
  const matches = [];
  for (const {id,value} of records) {
    if (value?.kind !== 'layer') continue;
    const layer = normalize(value.name);
    if (words.every(word => layer.includes(word))) {
      matches.push(searchResult(id,value.name,'Импортированный лесной слой',value.bounds));
      if (matches.length >= limit) break;
    }
    for (const feature of value.data.features) {
      const {name} = feature.properties;
      if (!name || !words.every(word => normalize(name + ' ' + value.name).includes(word))) continue;
      matches.push(searchResult(id,name,value.name,feature.bbox));
      if (matches.length >= limit) break;
    }
    if (matches.length >= limit) break;
  }
  return matches;
}

function segmentIntersects(a,b,c,d) {
  const side = ([x,y],[u,v],[px,py]) => Math.sign((u-x)*(py-y)-(v-y)*(px-x));
  const within = (p,x,y) => p[0] >= Math.min(x[0],y[0]) && p[0] <= Math.max(x[0],y[0]) &&
    p[1] >= Math.min(x[1],y[1]) && p[1] <= Math.max(x[1],y[1]);
  const abc = side(a,b,c);
  const abd = side(a,b,d);
  const cda = side(c,d,a);
  const cdb = side(c,d,b);
  return (abc * abd < 0 && cda * cdb < 0) ||
    (abc === 0 && within(c,a,b)) || (abd === 0 && within(d,a,b)) ||
    (cda === 0 && within(a,c,d)) || (cdb === 0 && within(b,c,d));
}

function isSimpleRing(points) {
  const distinct = new Set(points.map(([lng,lat]) => lng + ',' + lat));
  if (distinct.size !== points.length) return false;
  const ring = [...points,points[0]];
  for (let i = 0; i < points.length - 2; i++) {
    for (let j = i+2; j < points.length; j++) {
      if (i === 0 && j === points.length-1) continue;
      if (segmentIntersects(ring[i],ring[i+1],ring[j],ring[j+1])) return false;
    }
  }
  return true;
}

const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

function sphereVector([lng,lat]) {
  const lambda = lng * RADIANS;
  const phi = lat * RADIANS;
  return [Math.cos(phi)*Math.cos(lambda),Math.cos(phi)*Math.sin(lambda),Math.sin(phi)];
}

function sphereArea(points) {
  const vectors = points.map(sphereVector);
  const a = vectors[0];
  let solidAngle = 0;
  // Signed spherical triangles using Van Oosterom and Strackee's solid-angle formula.
  // Subtracting the anchor before the cross product avoids cancellation for small plots.
  for (let i = 1; i < vectors.length-1; i++) {
    const b = vectors[i];
    const c = vectors[i+1];
    const u = b.map((component,index) => component - a[index]);
    const v = c.map((component,index) => component - a[index]);
    const cross = [u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    solidAngle += 2*Math.atan2(dot(a,cross),1+dot(a,b)+dot(b,c)+dot(c,a));
  }
  return Math.abs(solidAngle) * EARTH_RADIUS ** 2;
}

function distance(a,b) {
  return trackDistance({lng:a[0],lat:a[1]},{lng:b[0],lat:b[1]});
}

export function measureShape(mode, points) {
  const area = mode === 'area';
  if (points.length < (area ? 3 : 2)) return {valid:false,issue:'points'};
  if (points.length > MAX_MEASUREMENT_POINTS || !points.every(position)) return {valid:false,issue:'coordinates'};
  let metres = 0;
  for (let i = 1; i < points.length; i++) metres += distance(points[i-1],points[i]);
  if (!area) return metres > 0 ? {valid:true,metres} : {valid:false,issue:'points'};
  if (!isSimpleRing(points)) return {valid:false,issue:'intersection'};
  const squareMetres = sphereArea(points);
  if (measureRing([...points,points[0]]) === 0 || squareMetres < 0.01) return {valid:false,issue:'points'};
  return {valid:true,metres:metres + distance(points.at(-1),points[0]),squareMetres};
}
