export const mapPaper = '#e9ebdf';

const sea = '#a8cad4';
const zoom = (...stops) => ['interpolate', ['linear'], ['zoom'], ...stops];
const kind = (...values) => ['match', ['get', 'kind'], values, true, false];
const details = (...values) => ['match', ['get', 'kind_detail'], values, true, false];
const name = ['coalesce', ['get', 'name:ru'], ['get', 'name'], ['get', 'name:en'], ''];
const rank = ['to-number', ['get', 'sort_key'], ['get', 'min_zoom'], 25];

function fill(id, sourceLayer, color, options = {}, paint = {}) {
  return { id, type: 'fill', source: 'region', 'source-layer': sourceLayer,
    paint: { 'fill-color': color, ...paint }, ...options };
}

function line(id, sourceLayer, color, width, options = {}, paint = {}) {
  return { id, type: 'line', source: 'region', 'source-layer': sourceLayer,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': color, 'line-width': width, ...paint }, ...options };
}

function label(id, sourceLayer, color, layout = {}, options = {}, paint = {}) {
  return { id, type: 'symbol', source: 'region', 'source-layer': sourceLayer, ...options,
    layout: { 'text-field': name, 'text-font': ['Arial'],
      'text-padding': 3, 'text-size': 12, ...layout },
    paint: { 'text-color': color, 'text-halo-color': '#faf8ee', 'text-halo-width': 1.3, ...paint }
  };
}

const arterial = kind('highway', 'major_road');
const streets = kind('minor_road', 'other');
const surface = ['!', ['has', 'is_tunnel']];
const majorWidth = zoom(5, 0.7, 8, 1.6, 11, 2.6, 14, 4.25, 16, 7.8, 18, 14);
const majorCasing = zoom(5, 1, 8, 2.35, 11, 3.8, 14, 5.8, 16, 10, 18, 17);
const streetWidth = zoom(10, 0.55, 12, 1.2, 14, 2.8, 16, 4.9, 18, 9.8);
const streetCasing = zoom(10, 0.85, 12, 1.9, 14, 3.65, 16, 6.6, 18, 12.5);
const arterialColor = ['match', ['get', 'kind_detail'],
  ['motorway', 'trunk'], '#f9ad64', 'primary', '#f8bf83', '#f9d19e'];
const largeTown = ['any', details('city', 'town'), ['>=', ['to-number', ['get', 'population_rank'], 0], 8]];
const localTown = ['all', kind('locality'), ['!', largeTown]];
const travelPlaces = kind(
  'airport', 'station', 'bus_station', 'ferry_terminal', 'fuel', 'camp_site', 'hotel',
  'viewpoint', 'museum', 'memorial', 'attraction', 'pharmacy', 'hospital', 'clinic',
  'supermarket', 'convenience', 'restaurant', 'cafe', 'mall', 'marketplace',
  'information', 'post_office', 'library', 'townhall'
);
const poiTint = ['match', ['get', 'kind'],
  ['hospital', 'pharmacy', 'clinic'], '#36686d',
  ['museum', 'viewpoint', 'memorial', 'attraction'], '#726282',
  ['fuel', 'supermarket', 'convenience', 'restaurant', 'cafe', 'mall', 'marketplace'], '#82603e', '#496358'];
const poiName = ['coalesce', ['get', 'name:ru'], ['get', 'name'],
  ['match', ['get', 'kind'], 'fuel', 'АЗС', 'pharmacy', 'Аптека', 'bus_station', 'Автостанция',
    'ferry_terminal', 'Паром', 'hospital', 'Больница', 'clinic', 'Клиника',
    ['convenience', 'supermarket'], 'Магазин', 'viewpoint', 'Смотровая площадка',
    'post_office', 'Почта', 'library', 'Библиотека', 'marketplace', 'Рынок', '']];

export function regionStyle(archiveURL) {
  return {
    version: 8,
    sources: {
      region: { type: 'vector', url: archiveURL, attribution: '© OpenStreetMap' }
    },
    layers: [
      { id: 'sea', type: 'background', paint: { 'background-color': sea } },
      fill('land', 'earth', mapPaper),
      fill('landcover', 'landcover', ['match', ['get', 'kind'],
        'forest', '#cbd7bd', 'grassland', '#d6ddc7', 'scrub', '#d6dbca',
        'barren', '#e3dfd1', 'urban_area', '#e7ded2', 'glacier', '#edf5f5',
        'farmland', '#e5e4cb', '#dce3d0'], {},
      { 'fill-opacity': zoom(5, 0.9, 8, 0.5, 10, 0.25, 12, 0) }),
      fill('landuse', 'landuse', ['match', ['get', 'kind'],
        ['forest', 'wood'], '#c8d7b9',
        ['nature_reserve', 'national_park', 'protected_area'], '#cddcc3',
        ['park', 'grass', 'grassland', 'cemetery', 'playground', 'golf_course'], '#d7e4ca',
        ['residential', 'neighbourhood'], '#eeebe3',
        ['industrial', 'construction', 'railway'], '#e1d9cc',
        ['commercial', 'retail'], '#e8ddce',
        ['school', 'university', 'hospital'], '#eadfce',
        ['wetland', 'marsh'], '#d1dfd7',
        ['sand', 'beach'], '#e9dfc9', 'rgba(0,0,0,0)']),
      fill('water', 'water', ['match', ['get', 'kind'], 'swimming_pool', '#9dc7d7', sea],
        { filter: ['==', ['geometry-type'], 'Polygon'] }),
      line('watercourses', 'water', '#89b4c5', zoom(7, 0.5, 11, 1.05, 14, 1.6, 18, 3.6),
        { filter: ['==', ['geometry-type'], 'LineString'] }),
      fill('buildings', 'buildings', '#ded7ca', { minzoom: 14 }),
      line('oblast-boundaries', 'boundaries', '#87938b', zoom(5, 0.55, 8, 0.95, 13, 1.2),
        { filter: kind('country', 'region') }, { 'line-dasharray': [4, 3], 'line-opacity': 0.67 }),
      line('district-boundaries', 'boundaries', '#98a197', zoom(8, 0.5, 13, 0.8),
        { minzoom: 8, filter: kind('county') }, { 'line-dasharray': [3, 3], 'line-opacity': 0.38 }),
      line('ferries', 'roads', '#668e9f', zoom(7, 0.55, 13, 1, 16, 1.55),
        { filter: kind('ferry') }, { 'line-dasharray': [3, 4] }),
      line('rail', 'roads', '#9d9082', zoom(7, 0.45, 12, 0.8, 16, 1.7),
        { filter: ['all', kind('rail'), surface] }, { 'line-dasharray': [4, 3], 'line-opacity': 0.76 }),
      line('tunnels', 'roads', '#d0ab90', zoom(10, 0.7, 14, 1.5, 18, 3),
        { filter: ['all', arterial, ['has', 'is_tunnel']] }, { 'line-dasharray': [3, 3] }),
      line('tracks-casing', 'roads', '#fff7e2', zoom(10, 0.9, 13, 2.4, 16, 4.3, 18, 5.8),
        { minzoom: 10, filter: ['all', kind('path'), surface], layout: {'line-join':'round'} },
        { 'line-opacity': .87 }),
      line('tracks', 'roads', '#895838', zoom(10, .55, 13, 1.25, 16, 2.2, 18, 3.1),
        { minzoom: 10, filter: ['all', kind('path'), surface], layout: {'line-join':'round'} },
        { 'line-dasharray': [2.6, 2.05], 'line-opacity': .96 }),
      line('minor-casing', 'roads', '#d4c6b5', streetCasing,
        { minzoom: 10, filter: ['all', streets, surface] }),
      line('minor-roads', 'roads', '#fffdf8', streetWidth,
        { minzoom: 10, filter: ['all', streets, surface] }),
      line('main-casing', 'roads', '#dfa672', majorCasing, { filter: ['all', arterial, surface] }),
      line('main-roads', 'roads', arterialColor, majorWidth, { filter: ['all', arterial, surface] }),
      label('water-name-lines', 'water', '#416f80',
        { 'symbol-placement': 'line', 'symbol-spacing': 230, 'text-size': zoom(9, 11, 15, 14) },
        { minzoom: 9, filter: ['==', ['geometry-type'], 'LineString'] },
        { 'text-halo-color': '#e7f1ee' }),
      label('water-name-points', 'water', '#416f80',
        { 'text-size': zoom(5, 11, 12, 14), 'text-max-width': 12, 'symbol-sort-key': rank },
        { filter: ['==', ['geometry-type'], 'Point'] },
        { 'text-halo-color': '#e7f1ee' }),
      label('route-numbers', 'roads', '#79532f',
        { 'text-field': ['get', 'ref'], 'text-font': ['Arial Bold', 'Arial'],
          'symbol-placement': 'line', 'symbol-spacing': 275, 'text-size': 10 },
        { minzoom: 7, maxzoom: 12, filter: ['all', arterial, ['has', 'ref']] },
        { 'text-halo-width': 2 }),
      label('street-names', 'roads', '#625747',
        { 'symbol-placement': 'line', 'symbol-spacing': 195, 'text-max-angle': 36,
          'text-size': zoom(11, 9.5, 14, 11, 18, 13.5) },
        { minzoom: 11, filter: ['any', arterial, streets] }),
      label('park-names', 'pois', '#4f6450',
        { 'text-size': zoom(10, 9, 14, 11.5, 17, 14), 'symbol-sort-key': rank, 'text-max-width': 11 },
        { minzoom: 10, filter: kind('national_park', 'park', 'nature_reserve') }),
      {
        id: 'useful-places', type: 'circle', source: 'region', 'source-layer': 'pois', minzoom: 13,
        filter: travelPlaces,
        paint: { 'circle-radius': zoom(13, 2, 16, 3, 18, 4), 'circle-color': poiTint,
          'circle-stroke-width': 1, 'circle-stroke-color': '#fcfaf2' }
      },
      label('poi-labels', 'pois', poiTint,
        { 'text-field': poiName, 'text-size': zoom(13, 9, 16, 11, 18, 12), 'symbol-sort-key': rank,
          'text-anchor': 'top', 'text-offset': [0, 0.55], 'text-max-width': 13 },
        { minzoom: 13, filter: travelPlaces }),
      label('district-labels', 'places', '#627269',
        { 'text-size': zoom(11, 9.5, 14, 12.5, 17, 16), 'symbol-sort-key': rank },
        { minzoom: 11, filter: kind('neighbourhood', 'macrohood', 'borough') }),
      label('town-labels', 'places', '#48594e',
        { 'text-size': zoom(7, 10, 10, 12, 14, 15.5), 'symbol-sort-key': rank, 'text-max-width': 11 },
        { minzoom: 7, filter: localTown }),
      label('city-labels', 'places', '#2c4a42',
        { 'text-font': ['Arial Bold', 'Arial'], 'text-size': zoom(5, 12, 8, 15.5, 12, 18, 16, 22),
          'symbol-sort-key': rank, 'text-max-width': 14 },
        { filter: ['all', kind('locality'), largeTown] })
    ]
  };
}
