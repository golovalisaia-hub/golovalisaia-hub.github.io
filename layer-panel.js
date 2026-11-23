import {layerInfo,openInstalledArchive,saveArchive,removeArchive,progressOnDisk,checkStorage} from './region-storage.js';

const groups = {details:['detail','forest','field-ways'],topography:['terrain','contours'],satellite:['satellite']};
const groupForMode = {satellite:'satellite',hybrid:'satellite',topographic:'topography'};
const kinds = Object.values(groups).flat();
const el = id => document.getElementById(id);
const format = new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1});
const size = bytes => format.format(bytes / 1024 / 1024) + ' МБ';

export function createLayerPanel({getMap,isReady,isBaseDownloading,downloadChanged}) {
  const dialog = el('layers-dialog');
  const modes = [...dialog.querySelectorAll('[data-layer-mode]')];
  const manifests = {};
  const assets = {};
  const savedBytes = {};
  let mode = 'map';
  let requestedMode;
  let transfer;
  let removing = false;
  let loaded = false;

  function notice(message = '',error = false) {
    const status = el('layer-notice');
    status.textContent = message;
    status.dataset.error = String(error);
    status.hidden = !message;
  }

  function bytesFor(group) {
    return {
      expected:group.reduce((total,kind) => total + (manifests[kind]?.bytes || 0),0),
      saved:group.reduce((total,kind) => total + (savedBytes[kind] || 0),0),
    };
  }

  function complete(group) { return group.every(kind => assets[kind]); }

  function available(group) { return group.every(kind => manifests[kind]); }

  function current(kind) {
    return Boolean(assets[kind] && (!manifests[kind] || assets[kind].manifest.version === manifests[kind].version));
  }

  function vectorState() {
    return {
      ...bytesFor(groups.details),ready:complete(groups.details),available:available(groups.details),loaded,
      detail:Boolean(assets.detail),forest:Boolean(assets.forest),satellite:Boolean(assets.satellite),
      field:Boolean(assets['field-ways']),
      versions:groups.details.map(kind => assets[kind]?.manifest.version),
    };
  }

  function vectorParts() {
    return groups.details.filter(kind => manifests[kind] && !current(kind)).map(kind => ({
      manifest:manifests[kind],saved:() => savedBytes[kind] || 0,
      progress(bytes) { savedBytes[kind] = bytes; },
      installed(archive) {
        assets[kind] = {archive,manifest:manifests[kind]};
        paint();
      },
    }));
  }

  function render() {
    const busy = Boolean(transfer || removing || isBaseDownloading());
    for (const [name,group] of Object.entries(groups)) {
      const {expected,saved} = bytesFor(group);
      const ready = complete(group);
      const update = ready && group.some(kind => !current(kind));
      const exists = available(group);
      const button = el('download-' + name);
      const remove = el('remove-' + name);
      const downloading = transfer?.group === group;
      const installedBytes = group.reduce((sum,kind) => sum + (assets[kind]?.manifest.bytes || 0),0);
      el(name + '-status').textContent = ready ? 'На устройстве · ' + size(installedBytes) +
        (update ? ' · обновление ' + size(expected - saved) : '') :
        exists ? (saved ? size(saved) + ' из ' + size(expected) : size(expected)) :
        loaded ? 'Пакет недоступен' : 'Подготовка…';
      button.hidden = (ready && !update) || downloading;
      button.textContent = update ? 'Обновить' : saved ? 'Продолжить' : 'Скачать';
      button.disabled = !isReady() || !exists || busy;
      remove.hidden = !(ready || saved);
      remove.disabled = busy;
    }
    el('layer-transfer').hidden = !transfer;
    if (transfer) {
      const {expected,saved} = bytesFor(transfer.group);
      const percent = Math.min(100,Math.floor(saved / expected * 100));
      el('layer-progress').value = percent;
      el('layer-progress-label').textContent = `${percent}% · ${size(saved)} из ${size(expected)}`;
    }
    for (const button of modes) button.setAttribute('aria-pressed',String(button.dataset.layerMode === mode));
    const treeCover = ['map','forest','topographic','outdoor'].includes(mode);
    el('forest-option').hidden = !treeCover || !assets.forest;
    el('forest-credit').hidden = !treeCover || !assets.forest || !el('show-forest').checked;
    el('satellite-credit').hidden = mode !== 'satellite' && mode !== 'hybrid';
    el('terrain-credit').hidden = mode !== 'topographic';
    el('overture-credit').hidden = !assets.detail || mode === 'satellite';
  }

  function paint() {
    getMap()?.updateLayers(assets,{mode,forest:el('show-forest').checked});
  }

  async function load() {
    await Promise.allSettled(kinds.map(async kind => {
      const manifest = await layerInfo(kind).catch(() => null);
      if (manifest) manifests[kind] = manifest;
      const installed = await openInstalledArchive(manifest || kind);
      if (installed) assets[kind] = installed;
      savedBytes[kind] = !manifest ? 0 : current(kind) ? manifest.bytes : await progressOnDisk(manifest);
      updateAttribution(kind);
    }));
    loaded = true;
    paint();
    downloadChanged();
  }

  function updateAttribution(kind) {
    const manifest = assets[kind]?.manifest || manifests[kind];
    if (!manifest) return;
    if (kind === 'satellite') {
      const resolution = Number.isFinite(manifest.groundResolution) ? 'около ' + manifest.groundResolution + ' м/пиксель' : '';
      el('satellite-attribution').textContent = [manifest.period,resolution,manifest.attribution].filter(Boolean).join(' · ');
    }
    if (kind === 'terrain') {
      el('terrain-attribution').textContent = [manifest.attribution,manifest.liabilityNotice].filter(Boolean).join(' ');
    }
  }

  async function download(group) {
    if (!isReady() || transfer || removing || isBaseDownloading() || !available(group)) return;
    if (!navigator.onLine) {
      notice('Подключись к интернету, чтобы скачать слой.',true);
      return;
    }
    const controller = new AbortController();
    transfer = {group,controller};
    el('layer-pause').disabled = false;
    notice();
    downloadChanged();
    if (navigator.storage?.persist) void navigator.storage.persist().catch(() => {});
    try {
      const {expected,saved} = bytesFor(group);
      await checkStorage(expected - saved);
      for (const kind of group) {
        if (current(kind)) continue;
        const manifest = manifests[kind];
        const archive = await saveArchive(manifest,{
          signal:controller.signal,
          onProgress(bytes) { savedBytes[kind] = bytes; render(); },
        });
        assets[kind] = {archive,manifest};
        updateAttribution(kind);
      }
      if (groups[groupForMode[requestedMode]] === group) {
        mode = requestedMode;
        requestedMode = undefined;
      }
      notice('Слой доступен без интернета.');
    } catch (error) {
      notice(controller.signal.aborted ? 'Загрузка на паузе. Скачанные части сохранены.' : error.message,!controller.signal.aborted);
      await Promise.all(group.map(async kind => {
        savedBytes[kind] = await progressOnDisk(manifests[kind]).catch(() => 0);
      }));
    } finally {
      transfer = undefined;
      paint();
      downloadChanged();
    }
  }

  async function clearGroup(group) {
    for (const kind of group) {
      await removeArchive(manifests[kind] || kind);
      delete assets[kind];
      delete savedBytes[kind];
    }
    const requirement = groups[groupForMode[mode]];
    if (requirement && !complete(requirement)) mode = 'map';
    paint();
  }

  async function remove(group) {
    if (transfer || removing || isBaseDownloading()) return;
    removing = true;
    downloadChanged();
    try {
      await clearGroup(group);
      notice('Слой удалён с устройства.');
    } catch (error) {
      notice(error.message,true);
    } finally {
      removing = false;
      paint();
      downloadChanged();
    }
  }

  for (const button of [el('map-layers'),...document.querySelectorAll('[data-open-layers]')]) {
    button.addEventListener('click',() => dialog.showModal());
  }
  for (const button of modes) {
    button.addEventListener('click',() => {
      const next = button.dataset.layerMode;
      const requirement = groupForMode[next];
      if (requirement && !complete(groups[requirement])) {
        requestedMode = next;
        notice(requirement === 'satellite' ? 'Скачай снимки, чтобы включить этот вид карты.' : 'Скачай рельеф и горизонтали для топографической карты.');
        const control = el('download-' + requirement);
        if (!control.disabled) control.focus();
        return;
      }
      mode = next;
      requestedMode = undefined;
      notice();
      paint();
      render();
      dialog.close();
    });
  }
  for (const [name,group] of Object.entries(groups)) {
    el('download-' + name).addEventListener('click',() => void download(group));
    el('remove-' + name).addEventListener('click',() => void remove(group));
  }
  el('layer-pause').addEventListener('click',() => {
    el('layer-pause').disabled = true;
    transfer?.controller.abort();
  });
  el('show-forest').addEventListener('change',() => { paint(); render(); });

  return {
    load,paint,render,vectorParts,vectorState,clearVector:() => clearGroup(groups.details),
    hasDetail:() => Boolean(assets.detail),isBusy:() => Boolean(transfer || removing),
  };
}
