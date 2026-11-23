import {
  Map as LibreMap, Marker, MercatorCoordinate, ScaleControl, addProtocol, setWorkerUrl
} from '/vendor/maplibre-gl.mjs';
import { PMTiles, TileType } from '/vendor/pmtiles.js';
import { regionStyle, mapPaper } from './map-style.js';
import {applyOverlayMode,fieldWayHits,houseFill,houseNumbers,overlayStyles} from './map-layers-style.js';

const sources = new Map();
let sourceId = 0;
const rasterTypes = new Set([TileType.Png,TileType.Jpeg,TileType.Webp,TileType.Avif]);
const transparentPixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
const transparentImage = Uint8Array.from(atob(transparentPixel), char => char.charCodeAt(0));

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Чтение карты остановлено.', 'AbortError');
}

function archiveReader(archive, token) {
  const blob = archive instanceof ArrayBuffer ? new Blob([archive]) : archive;
  if ((!blob?.getBytes && !(blob instanceof Blob)) || blob.size < 127) {
    throw new Error('Локальный архив карты недоступен.');
  }
  return new PMTiles({
    getKey: () => token,
    async getBytes(offset, length, signal) {
      checkAbort(signal);
      const data = blob instanceof Blob ? await blob.slice(offset, offset + length).arrayBuffer() :
        await blob.getBytes(offset,length,signal);
      checkAbort(signal);
      return { data };
    }
  });
}

setWorkerUrl('/vendor/maplibre-gl-worker.mjs');
addProtocol('quiet', async ({ url }, { signal }) => {
  checkAbort(signal);
  const request = new URL(url);
  const source = sources.get(request.hostname);
  if (!source) throw new DOMException('Карта закрыта.', 'AbortError');
  try {
    if (request.pathname === '/tiles') {
      const header = await source.reader.getHeader();
      const minzoom = Math.max(header.minZoom, source.pack.minZoom);
      const maxzoom = Math.min(header.maxZoom, source.pack.maxZoom);
      const kindIsCorrect = source.type === 'raster' ? rasterTypes.has(header.tileType) : header.tileType === TileType.Mvt;
      if (!kindIsCorrect || maxzoom < minzoom) throw new Error('Архив имеет неподходящий тип или масштаб.');
      source.maxZoom = maxzoom;
      checkAbort(signal);
      return { data: { tilejson: '3.0.0', bounds: source.pack.bounds, minzoom, maxzoom,
        tiles: [`quiet://${request.hostname}/{z}/{x}/{y}`] } };
    }
    const [z, x, y] = request.pathname.slice(1).split('/').map(Number);
    const tile = await source.reader.getZxy(z, x, y, signal);
    checkAbort(signal);
    if (tile) return {data:tile.data};
    return {data:source.type === 'raster' ? transparentImage.slice().buffer : new ArrayBuffer(0)};
  } catch (error) {
    checkAbort(signal);
    throw new Error('Не удалось прочитать локальный архив карты.', { cause: error });
  }
});

function markerElement() {
  const marker = document.createElement('div');
  marker.className = 'position-marker';
  marker.setAttribute('aria-hidden', 'true');
  marker.style.pointerEvents = 'none';
  for (const part of ['accuracy', 'heading', 'dot']) {
    const element = document.createElement('span');
    element.className = 'position-marker__' + part;
    marker.append(element);
  }
  return marker;
}

export function createMap({ container, pack, archive, onReady, onError, onBuilding, onFieldFeature }) {
  const token = String(++sourceId);
  const [west, south, east, north] = pack.bounds;
  const bounds = [[west, south], [east, north]];
  const source = {pack, reader:archiveReader(archive,token), maxZoom:pack.maxZoom,type:'vector'};
  sources.set(token, source);
  const style = regionStyle(`quiet://${token}/tiles`);
  const baseLayers = style.layers;
  if (!container.style.backgroundColor) container.style.backgroundColor = mapPaper;
  let map;
  try {
    map = new LibreMap({
      container,
      style,
      center: pack.center,
      zoom: pack.minZoom,
      minZoom: pack.minZoom,
      maxZoom: 20,
      locale: { 'Map.Title': 'Карта', 'ScaleControl.Meters': 'м', 'ScaleControl.Kilometers': 'км' },
      renderWorldCopies: false,
      attributionControl: false,
      dragRotate: false,
      touchPitch: false,
      maxTileCacheSize: 64
    });
  } catch (error) {
    sources.delete(token);
    throw error;
  }

  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new ScaleControl({ maxWidth: 96, unit: 'metric' }), 'bottom-left');
  map.getCanvas().setAttribute('aria-label', 'Карта. ' + pack.name);

  let initialError = false;
  let loaded = false;
  let destroyed = false;
  let pendingFit = true;
  let positionMarker;
  let position;
  const overlays = new Map();
  let shownMode = 'map';
  let shownForest = true;

  map.once('load', () => {
    loaded = true;
    map.setMaxZoom(Math.min(18, source.maxZoom + 4));
    if (!initialError) onReady?.(map);
  });
  map.on('error', ({ error }) => {
    if (!loaded && initialError) return;
    initialError ||= !loaded;
    onError?.(error);
  });
  if (onBuilding || onFieldFeature) map.on('click', event => {
    if (shownMode === 'satellite') return;
    const point = event.lngLat.toArray();
    const [building] = map.getLayer(houseFill) ?
      map.queryRenderedFeatures(event.point,{layers:[houseFill,houseNumbers]}) : [];
    if (building) {
      const center = building.geometry.type === 'Point' ? building.geometry.coordinates : point;
      onBuilding?.({properties:building.properties,center});
      return;
    }
    if (!onFieldFeature || !overlays.has('field-ways')) return;
    const {x,y} = event.point;
    const [feature] = map.queryRenderedFeatures([[x-5,y-5],[x+5,y+5]],{layers:fieldWayHits});
    if (feature) onFieldFeature({properties:feature.properties,
      center:feature.geometry.type === 'Point' ? feature.geometry.coordinates : point});
  });

  function installOverlay(kind,entry) {
    const previous = overlays.get(kind);
    if (entry?.archive === previous?.archive) return false;
    const layer = overlayStyles[kind];
    const id = 'quiet-' + kind;
    if (previous) {
      for (const definition of layer.layers) map.removeLayer(definition.id);
      map.removeSource(id);
      sources.delete(previous.token);
      overlays.delete(kind);
    }
    if (!entry) return Boolean(previous);
    const {archive,manifest} = entry;
    const idToken = String(++sourceId);
    const overlayPack = {bounds:pack.bounds,minZoom:manifest.minZoom,maxZoom:manifest.maxZoom};
    const reader = archiveReader(archive,idToken);
    sources.set(idToken,{pack:overlayPack,reader,type:layer.type,maxZoom:manifest.maxZoom});
    overlays.set(kind,{token:idToken,archive});
    map.addSource(id,{
      type:layer.type,url:`quiet://${idToken}/tiles`,
      ...(layer.type === 'raster' ? {tileSize:manifest.tileSize || 256} : {}),
    });
    for (const definition of layer.layers) {
      const insertion = definition.type === 'symbol' ? layer.labelBefore : layer.before;
      map.addLayer(definition,map.getLayer(insertion) ? insertion : undefined);
    }
    return true;
  }

  function updateLayers(assets,{mode = 'map',forest = true} = {}) {
    if (!loaded || destroyed) return;
    let changed = false;
    for (const kind of ['forest','terrain','satellite','detail','contours','field-ways']) {
      if (installOverlay(kind,assets[kind])) changed = true;
    }
    const needsPhotos = mode === 'satellite' || mode === 'hybrid';
    const modeToShow = (needsPhotos && !overlays.has('satellite')) ||
      (mode === 'topographic' && (!overlays.has('terrain') || !overlays.has('contours'))) ? 'map' : mode;
    if (!changed && modeToShow === shownMode && forest === shownForest) return;
    shownMode = modeToShow;
    shownForest = forest;
    map.setMaxZoom(overlays.has('detail') ? 20 : Math.min(18, source.maxZoom + 4));
    applyOverlayMode(map,baseLayers,{mode:shownMode,forest:shownForest,detail:overlays.has('detail'),field:overlays.has('field-ways')});
  }

  function fit(duration = 200) {
    if (destroyed) return;
    const size = Math.min(container.clientWidth, container.clientHeight);
    if (size < 24) return;
    const padding = Math.min(46, Math.round(size * 0.08));
    map.fitBounds(bounds, { padding, maxZoom: Math.min(16, source.maxZoom + 1), duration });
    pendingFit = false;
  }

  function resize() {
    if (destroyed) return;
    map.resize();
    if (pendingFit) fit(0);
  }

  function zoomBy(delta) {
    if (!destroyed && Number.isFinite(delta)) map.zoomTo(map.getZoom() + delta, { duration: 180 });
  }

  function inside(lng, lat) {
    return Number.isFinite(lng) && Number.isFinite(lat) && lng >= west && lng <= east && lat >= south && lat <= north;
  }

  function visit(lngLat, zoom = 12) {
    const [lng, lat] = Array.isArray(lngLat) ? lngLat : [lngLat?.lng, lngLat?.lat];
    if (destroyed || !inside(lng, lat) || !Number.isFinite(zoom)) return false;
    const limit = overlays.has('detail') ? 20 : Math.min(18,source.maxZoom + 1.5);
    map.easeTo({ center: [lng, lat], zoom: Math.min(zoom,limit), duration: 260 });
    return true;
  }

  function clearPosition() {
    positionMarker?.remove();
    positionMarker = undefined;
    position = undefined;
  }

  function updateAccuracy() {
    if (!positionMarker || !position) return;
    const size = position.accuracy * MercatorCoordinate.fromLngLat(position.point).meterInMercatorCoordinateUnits()
      * 512 * 2 ** map.getZoom() * 2;
    positionMarker.getElement().style.setProperty('--position-accuracy', `${Math.min(2048, size)}px`);
  }
  map.on('zoom', updateAccuracy);

  function setPosition({ lng, lat, accuracy, heading, follow = false, stale = false, recenter = false }) {
    if (destroyed || !inside(lng, lat)) {
      clearPosition();
      return false;
    }
    const point = [lng, lat];
    position = { point, accuracy: Number.isFinite(accuracy) ? Math.max(0, accuracy) : 0 };
    if (!positionMarker) {
      positionMarker = new Marker({ element: markerElement(), anchor: 'center' }).setLngLat(point).addTo(map);
    } else {
      positionMarker.setLngLat(point);
    }
    const element = positionMarker.getElement();
    element.classList.toggle('is-stale',stale);
    element.classList.toggle('has-heading',!stale && Number.isFinite(heading));
    if (!stale && Number.isFinite(heading)) element.style.setProperty('--position-heading', `${heading}deg`);
    else element.style.removeProperty('--position-heading');
    updateAccuracy();
    if (follow && !stale) {
      const target = shownMode === 'satellite' ? 11 : overlays.has('detail') ? 15 : Math.min(14,source.maxZoom + 1);
      map.easeTo({center:point,duration:220,...(recenter ? {zoom:Math.max(target,map.getZoom())} : {})});
    }
    return true;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearPosition();
    sources.delete(token);
    for (const entry of overlays.values()) sources.delete(entry.token);
    overlays.clear();
    map.remove();
  }

  fit(0);
  return { fit, resize, zoomBy, visit, destroy, map, setPosition, clearPosition,updateLayers };
}
