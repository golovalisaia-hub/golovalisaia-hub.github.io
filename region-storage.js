import {PMTiles, TileType} from '/vendor/pmtiles.js';
import {createArchiveProtection,sealedSize} from './archive-protection.js';

const filePrefixes = {
  map:'region',navigation:'navigation',walking:'walking',detail:'detail',
  forest:'forest',terrain:'terrain',contours:'contours',satellite:'satellite','field-ways':'field-ways',
};
const tileTypes = {
  map:TileType.Mvt,detail:TileType.Mvt,contours:TileType.Mvt,'field-ways':TileType.Mvt,
  forest:TileType.Png,terrain:TileType.Webp,satellite:TileType.Webp,
};
const regionalProbes = [[33.08422,68.97243],[33.65,67.68],[35.1221,69.1788],[32.58793,68.05911],[30.5,67.5],[38.7,66.5]];
const maxChunkSize = 12 * 1024 * 1024;
const versionPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const digestHeader = 'X-Quiet-Digest';
const formatHeader = 'X-Quiet-Archive';
const activationPath = '/.quiet-map-package';
const cachePrefix = kind => 'quiet-' + (kind === 'map' ? 'murmansk' : kind) + '-';
const cacheName = ({kind,version}) => cachePrefix(kind) + version;
const key = path => new URL(path, location.origin).href;

function invalidManifest() { return new Error('Описание пакета повреждено.'); }
function invalidArchive() { return new Error('Не удалось прочитать проверенный локальный архив.'); }
function invalidLength() { return new Error('Размер файла карты не совпал. Попробуй продолжить загрузку.'); }

function validPosition([lng,lat]) {
  return Number.isFinite(lng) && Math.abs(lng) <= 180 && Number.isFinite(lat) && Math.abs(lat) <= 85.051129;
}

function zoomValid(info) {
  return Number.isInteger(info?.minZoom) && Number.isInteger(info?.maxZoom) &&
    info.minZoom >= 0 && info.minZoom <= info.maxZoom && info.maxZoom <= 22;
}

function validRegion(region) {
  if (region?.id !== 'murmansk-oblast' || typeof region.name !== 'string' || !zoomValid(region) ||
      !Array.isArray(region.center) || region.center.length !== 2 ||
      !Array.isArray(region.bounds) || region.bounds.length !== 4) return false;
  const [west,south,east,north] = region.bounds;
  const [lng,lat] = region.center;
  return validPosition([west,south]) && validPosition([east,north]) && validPosition(region.center) &&
    lng > west && lng < east && lat > south && lat < north;
}

function verifyManifest(info,kind) {
  if (!Object.hasOwn(filePrefixes,kind) || !info || (info.kind !== undefined && info.kind !== kind) ||
      typeof info.version !== 'string' || !versionPattern.test(info.version) ||
      !Array.isArray(info.chunks) || info.chunks.length === 0 || info.chunks.length > 2048 ||
      !Number.isSafeInteger(info.bytes) || info.bytes <= 0) throw invalidManifest();
  const prefix = '/data/' + filePrefixes[kind] + '-' + info.version + '-';
  if (info.chunks.some((chunk,index) => chunk?.path !== prefix + index + '.bin' ||
      typeof chunk.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(chunk.sha256) ||
      !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 1 || chunk.bytes > maxChunkSize) ||
      info.chunks.reduce((sum,chunk) => sum + chunk.bytes,0) !== info.bytes) throw invalidManifest();
  if (kind === 'map' && (!validRegion(info.region) || !Array.isArray(info.places) ||
      !Number.isInteger(info.previewZoom) || info.previewZoom < info.region.minZoom || info.previewZoom > info.region.maxZoom)) {
    throw invalidManifest();
  }
  if (Object.hasOwn(tileTypes,kind) && kind !== 'map' && !zoomValid(info)) throw invalidManifest();
  if ((kind === 'walking' && info.profile !== 'walk') ||
      (kind === 'navigation' && info.profile !== undefined && info.profile !== 'car')) throw invalidManifest();
  return {...info,kind};
}

function samePackage(a,b) {
  const zooms = manifest => {
    const {minZoom,maxZoom} = manifest.kind === 'map' ? manifest.region : manifest;
    return minZoom + '/' + maxZoom;
  };
  return a.kind === b.kind && a.version === b.version && a.bytes === b.bytes &&
    a.chunks.length === b.chunks.length && zooms(a) === zooms(b) &&
    a.chunks.every((chunk,index) => chunk.sha256 === b.chunks[index].sha256 && chunk.bytes === b.chunks[index].bytes);
}

async function activated(cache,kind) {
  const marker = await cache.match(key(activationPath));
  if (!marker) return null;
  try {
    const {schema,manifest,at} = await marker.json();
    if (schema !== 1 || !Number.isFinite(at)) return null;
    return {manifest:verifyManifest(manifest,kind),at};
  } catch { return null; }
}

async function activate(cache,manifest) {
  const previous = await activated(cache,manifest.kind);
  if (previous) {
    if (!samePackage(manifest,previous.manifest)) throw invalidManifest();
    return;
  }
  // One CacheStorage write publishes the validated files together. Chunk writes remain resumable.
  await cache.put(key(activationPath),new Response(JSON.stringify({schema:1,manifest,at:Date.now()}),{
    headers:{'Content-Type':'application/json'},
  }));
}

async function hasDigest(bytes, expected) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  const hex = Array.from(digest,byte => byte.toString(16).padStart(2,'0')).join('');
  return hex === expected;
}

async function storedPart(cache,chunk) {
  const saved = await cache.match(key(chunk.path));
  if (!saved || saved.headers.get(digestHeader) !== chunk.sha256) return null;
  const blob = await saved.blob();
  const format = saved.headers.get(formatHeader);
  if (format === '1' && blob.size === sealedSize(chunk.bytes)) return {blob,sealed:true};
  return format === null && blob.size === chunk.bytes ? {blob,sealed:false} : null;
}

async function storeProtected(cache,chunk,bytes,protection) {
  const sealed = await protection.seal(chunk,bytes);
  await cache.put(key(chunk.path),new Response(sealed,{
    headers:{'Content-Type':'application/octet-stream',[digestHeader]:chunk.sha256,[formatHeader]:'1'},
  }));
  const stored = await storedPart(cache,chunk);
  if (!stored?.sealed) throw new Error('Часть карты исчезла из хранилища. Продолжи скачивание.');
  return stored.blob;
}

async function inspectParts(cache,manifest,protection) {
  const parts = [];
  let bytes = 0;
  for (const chunk of manifest.chunks) {
    protection.signal.throwIfAborted();
    const stored = await storedPart(cache,chunk);
    const data = !stored ? null : stored.sealed ?
      await protection.readPart(stored.blob,chunk).catch(() => null) :
      new Uint8Array(await stored.blob.arrayBuffer());
    protection.signal.throwIfAborted();
    if (!data || !await hasDigest(data,chunk.sha256)) {
      parts.push(null);
      continue;
    }
    // Legacy files are checked against the original manifest before replacement.
    parts.push(stored.sealed ? stored.blob : await storeProtected(cache,chunk,data,protection));
    bytes += chunk.bytes;
  }
  return {parts,bytes};
}

function tileAt(z,[lng,lat]) {
  const width = 2 ** z;
  return [z,Math.floor((lng + 180) / 360 * width),
    Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * width)];
}

function tileReadable(tile,type) {
  if (!tile || tile.data.byteLength < 2) return false;
  const bytes = new Uint8Array(tile.data,0,Math.min(12,tile.data.byteLength));
  if (type === TileType.Mvt) return bytes[0] === 26;
  if (type === TileType.Png) return bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  return bytes.length === 12 && String.fromCharCode(...bytes.subarray(0,4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8,12)) === 'WEBP';
}

async function readMapSamples(archive,manifest,signal) {
  const reader = new PMTiles({
    getKey:() => cacheName(manifest),
    async getBytes(offset,length) {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 ||
          length <= 0 || length > maxChunkSize ||
          (offset + length > archive.size && !(offset === 0 && length === 16384))) throw invalidArchive();
      return {data:await archive.getBytes(offset,length,signal)};
    },
  });
  const header = await reader.getHeader();
  const expected = manifest.kind === 'map' ? manifest.region : manifest;
  if (header.specVersion !== 3 || header.tileType !== tileTypes[manifest.kind] ||
      header.minZoom !== expected.minZoom || header.maxZoom !== expected.maxZoom ||
      !Number.isSafeInteger(header.numAddressedTiles) || header.numAddressedTiles < 1 ||
      header.tileDataOffset + header.tileDataLength > archive.size) throw invalidArchive();
  const probes = [[header.centerLon,header.centerLat],...regionalProbes].filter(validPosition);
  for (const z of new Set([header.minZoom,header.maxZoom])) {
    let readable = false;
    for (const point of probes) {
      const coordinates = tileAt(z,point);
      const tile = await reader.getZxy(...coordinates,signal);
      if (tileReadable(tile,header.tileType)) { readable = true; break; }
    }
    if (!readable) throw invalidArchive();
  }
}

async function readRoutingSample(archive) {
  // Navigation bundles start with the JSON schema and the first graph node.
  const reader = archive.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  try {
    const decoder = new TextDecoder();
    let prefix = '';
    while (prefix.length < 160) {
      const {done,value} = await reader.read();
      if (done) break;
      prefix += decoder.decode(value.subarray(0,160 - prefix.length),{stream:true});
    }
    if (!/^\s*\{\s*"schema"\s*:\s*1\s*,\s*"nodes"\s*:\s*\[\s*\[\s*-?\d/.test(prefix)) throw invalidArchive();
  } finally { await reader.cancel().catch(() => {}); }
}

async function validateArchive(archive,manifest,signal) {
  try {
    if (Object.hasOwn(tileTypes,manifest.kind)) await readMapSamples(archive,manifest,signal);
    else await readRoutingSample(archive);
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(invalidArchive().message,{cause:error});
  }
}

async function openVerified(cache,manifest,adopt,protection) {
  const {parts,bytes} = await inspectParts(cache,manifest,protection);
  if (bytes !== manifest.bytes) return null;
  const archive = protection.archive(parts,manifest);
  try { await validateArchive(archive,manifest,protection.signal); }
  catch { protection.signal.throwIfAborted(); return null; }
  if (adopt) await activate(cache,manifest);
  return archive;
}

async function openArchive(input,protection) {
  const manifest = verifyManifest(input,input?.kind);
  const name = cacheName(manifest);
  if (!await caches.has(name)) return null;
  const cache = await caches.open(name);
  const record = await activated(cache,manifest.kind);
  if (record && !samePackage(record.manifest,manifest)) return null;
  return openVerified(cache,manifest,!record,protection);
}

async function packageNames(kind) {
  if (!Object.hasOwn(filePrefixes,kind)) throw invalidManifest();
  const prefix = cachePrefix(kind);
  return (await caches.keys()).filter(name => name.startsWith(prefix) && versionPattern.test(name.slice(prefix.length)));
}

async function openInstalledArchive(input,protection) {
  const current = typeof input === 'string' ? null : verifyManifest(input,input?.kind);
  const kind = current?.kind || input;
  if (current) {
    const archive = await openArchive(current,protection);
    if (archive) return {archive,manifest:current};
  }
  const fallbacks = [];
  for (const name of await packageNames(kind)) {
    const cache = await caches.open(name);
    const record = await activated(cache,kind);
    if (record && cacheName(record.manifest) === name && !(current && samePackage(current,record.manifest))) {
      fallbacks.push({...record,cache});
    }
  }
  fallbacks.sort((a,b) => b.at - a.at);
  for (const {cache,manifest} of fallbacks) {
    const archive = await openVerified(cache,manifest,false,protection);
    if (archive) return {archive,manifest};
  }
  return null;
}

async function progressOnDisk(input,protection) {
  const manifest = verifyManifest(input,input?.kind);
  const name = cacheName(manifest);
  if (!await caches.has(name)) return 0;
  const cache = await caches.open(name);
  const record = await activated(cache,manifest.kind);
  return record && !samePackage(manifest,record.manifest) ? 0 : (await inspectParts(cache,manifest,protection)).bytes;
}

let inThisTab = false;
async function exclusively(action) {
  if (navigator.locks) {
    return navigator.locks.request('quiet-map-download',{ifAvailable:true},lock => {
      if (!lock) throw new Error('Карта загружается в другом окне.');
      return action();
    });
  }
  if (inThisTab) throw new Error('Карта уже загружается.');
  inThisTab = true;
  try { return await action(); }
  finally { inThisTab = false; }
}

async function fetchPart(chunk,signal) {
  function interrupted() {
    signal?.throwIfAborted();
    return new Error('Связь прервалась. Скачанная часть сохранена.');
  }
  let response;
  try {
    response = await fetch(key(chunk.path),{credentials:'same-origin',cache:'no-store',redirect:'error',signal});
  } catch {
    throw interrupted();
  }
  if (!response.ok || !response.body) throw new Error('Не удалось скачать часть карты. Загрузку можно продолжить.');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(chunk.bytes);
  let offset = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read().catch(() => { throw interrupted(); });
      if (done) break;
      if (offset + value.byteLength > bytes.byteLength) throw invalidLength();
      bytes.set(value,offset);
      offset += value.byteLength;
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (offset !== chunk.bytes) throw invalidLength();
  if (!await hasDigest(bytes,chunk.sha256)) {
    throw new Error('Не совпала контрольная сумма карты. Попробуй продолжить загрузку.');
  }
  signal?.throwIfAborted();
  return bytes;
}

function saveArchive(input,protection,{signal:request,onProgress} = {}) {
  const signal = request ? AbortSignal.any([protection.signal,request]) : protection.signal;
  return exclusively(async () => {
    signal?.throwIfAborted();
    const manifest = verifyManifest(input,input?.kind);
    const cache = await caches.open(cacheName(manifest));
    const record = await activated(cache,manifest.kind);
    if (record && !samePackage(manifest,record.manifest)) throw invalidManifest();
    const {parts,bytes} = await inspectParts(cache,manifest,protection);
    let savedBytes = bytes;
    onProgress?.(savedBytes,manifest.bytes);
    for (const [index,chunk] of manifest.chunks.entries()) {
      signal?.throwIfAborted();
      if (parts[index]) continue;
      const data = await fetchPart(chunk,signal);
      parts[index] = await storeProtected(cache,chunk,data,protection);
      savedBytes += chunk.bytes;
      onProgress?.(savedBytes,manifest.bytes);
    }
    signal?.throwIfAborted();
    const archive = protection.archive(parts,manifest);
    await validateArchive(archive,manifest,signal);
    await activate(cache,manifest);
    return archive;
  }).catch(error => {
    if (error?.name === 'QuotaExceededError') throw new Error('Недостаточно места. Освободи память и продолжи загрузку.');
    throw error;
  });
}

async function removeArchive(input) {
  const kind = typeof input === 'string' ? input : input?.kind;
  return exclusively(async () => (await Promise.all((await packageNames(kind)).map(name => caches.delete(name)))).some(Boolean));
}

export function createMapStorage(fieldKey) {
  const protection = createArchiveProtection(fieldKey);
  return {
    close:protection.close,
    async openArchive(input) { await protection.verify(); return openArchive(input,protection); },
    async openInstalledArchive(input) { await protection.verify(); return openInstalledArchive(input,protection); },
    async progressOnDisk(input) { await protection.verify(); return progressOnDisk(input,protection); },
    async saveArchive(input,options) { await protection.verify(); return saveArchive(input,protection,options); },
    async removeArchive(input) { await protection.verify(); return removeArchive(input); },
  };
}

async function readManifest(url,kind) {
  const response = await fetch(url,{redirect:'error'});
  if (!response.ok) throw new Error('Не удалось открыть сведения о скачивании.');
  return verifyManifest(await response.json(),kind);
}

export const regionInfo = () => readManifest('/data/murmansk.json','map');
export const navigationInfo = () => readManifest('/data/navigation.json','navigation');
export const walkingInfo = () => readManifest('/data/walking.json','walking');
export async function layerInfo(kind) {
  if (!Object.hasOwn(tileTypes,kind) || kind === 'map') throw invalidManifest();
  return readManifest('/data/' + kind + '.json',kind);
}

export async function checkStorage(bytes) {
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  if (estimate && Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage) &&
      bytes > Math.max(0,estimate.quota - estimate.usage)) {
    throw new Error('Недостаточно места для пакета. Освободи память или удали ненужные слои.');
  }
}
