import {locationText} from './position-data.js';

const date = new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'medium'});

export function createPositionReadout({dialog,prefix,getState}) {
  const field = name => document.getElementById(prefix + '-' + name);
  const status = field('position-status');
  const coordinates = field('coordinates');
  const details = field('fix-details');
  const copy = field('copy');
  const fallback = field('copy-fallback');
  const message = field('copy-status');
  let revision = 0;

  function forgetCopy() {
    fallback.value = '';
    fallback.hidden = true;
    message.textContent = '';
    message.hidden = true;
  }

  function render({fix,last,positionLabel}) {
    const point = fix || last;
    if (status.textContent !== positionLabel) status.textContent = positionLabel;
    coordinates.hidden = details.hidden = copy.disabled = !point;
    coordinates.textContent = point ? point.lat.toFixed(6) + ', ' + point.lng.toFixed(6) : '';
    details.textContent = point ? 'Точность ±' + Math.ceil(point.accuracy) + ' м · ' + date.format(point.timestamp) : '';
  }

  function clear() {
    revision += 1;
    render({positionLabel:''});
    forgetCopy();
  }

  dialog.addEventListener('close',() => { if (!dialog.open) clear(); });
  copy.addEventListener('click',async () => {
    const {fix,last} = getState();
    const point = fix || last;
    if (!point || !dialog.open) return;
    const current = ++revision;
    const text = (fix ? '' : 'Последняя известная позиция · ') + locationText(point);
    forgetCopy();
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (current !== revision || !dialog.open) return;
      message.textContent = 'Координаты скопированы.';
      message.hidden = false;
    } catch {
      if (current !== revision || !dialog.open) return;
      fallback.value = text;
      fallback.hidden = false;
      fallback.focus();
      fallback.select();
    }
  });
  return {render,clear};
}
