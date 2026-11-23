import {isFieldUnlockPin,openFieldSecurity} from './field-security.js';

const id = value => document.getElementById(value);
const inactivity = 5 * 60 * 1000;
const operation = {
  '+':(a,b) => a + b, '-':(a,b) => a - b,
  '*':(a,b) => a * b, '/':(a,b) => a / b,
};
const failure = {
  'wrong-pin':'Код не подошёл.',
  'invalid-pin':'Код должен содержать от 4 до 20 цифр.',
  'wrong-recovery':'Код восстановления не подошёл.',
  'recovery-unavailable':'Для этих записей код восстановления не задан.',
  'already-configured':'Код уже настроен. Открой карты через калькулятор.',
  'credentials-changed':'Код изменился в другой вкладке. Попробуй снова.',
  'storage-blocked':'Хранилище устройства недоступно.',
  'field-corrupt':'Не удалось прочитать настройки защиты.',
};

export function createPrivacyLock({onUnlock,onLock}) {
  const calculator = id('calculator');
  const screen = id('privacy-screen');
  const form = id('privacy-form');
  const recoveryCard = id('privacy-recovery-card');
  const workspace = document.querySelector('.workspace');
  const status = id('privacy-status');
  let security;
  let configured = false;
  let unlocked = false;
  let busy = false;
  let revision = 0;
  let recovering = false;
  let pendingKey;
  let idleTimer;
  let entry = '';
  let left;
  let operator;
  let replace = false;

  function message(text = '') { status.textContent = text; }
  function buttons() {
    id('privacy-setup-open').hidden = !security || configured;
    id('privacy-recovery-open').hidden = !configured;
  }
  function display() {
    id('calculator-display').textContent = !operator && /^\d+$/.test(entry) && configured && !replace ?
      '•'.repeat(Math.min(entry.length,16)) : entry || '0';
  }
  function resetEntry() {
    entry = '';
    operator = undefined;
    left = undefined;
    replace = false;
    display();
  }
  function showCalculator() {
    form.reset();
    form.hidden = true;
    id('privacy-recovery-value').textContent = '';
    recoveryCard.hidden = true;
    calculator.hidden = false;
    pendingKey = undefined;
    resetEntry();
    buttons();
  }
  function showForm(forRecovery) {
    recovering = forRecovery;
    calculator.hidden = true;
    id('privacy-recovery-label').hidden = !forRecovery;
    id('privacy-recovery').required = forRecovery;
    id('privacy-form-title').textContent = forRecovery ? 'Восстановление доступа' : 'Код для карт';
    id('privacy-submit').textContent = forRecovery ? 'Сменить код' : 'Создать код';
    form.hidden = false;
    message();
    id(forRecovery ? 'privacy-recovery' : 'privacy-pin').focus();
  }
  function activity() {
    if (!unlocked) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(lock,inactivity);
  }
  function unlock(key) {
    if (document.hidden) return;
    showCalculator();
    message();
    workspace.inert = false;
    workspace.hidden = false;
    screen.hidden = true;
    unlocked = true;
    activity();
    onUnlock(key);
  }
  function lock() {
    revision += 1;
    clearTimeout(idleTimer);
    const wasUnlocked = unlocked;
    unlocked = false;
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    workspace.inert = true;
    workspace.hidden = true;
    screen.hidden = false;
    showCalculator();
    message();
    screen.focus({preventScroll:true});
    if (wasUnlocked) onLock();
  }
  function report(error) {
    if (error?.code === 'cooldown') {
      const seconds = Math.max(1,Math.ceil((error.retryAt - Date.now()) / 1000));
      message('Повтори попытку через ' + seconds + ' с.');
    } else message(failure[error?.code] || 'Не удалось открыть защищённые данные.');
  }

  async function tryPin(pin) {
    if (!security || !configured || busy) return;
    const current = revision;
    busy = true;
    resetEntry();
    message('Проверяем код…');
    try {
      const key = await security.unlock(pin);
      if (current === revision) unlock(key);
    } catch (error) {
      if (current === revision) report(error);
    } finally {
      busy = false;
    }
  }

  function calculate() {
    const result = operation[operator](left,Number(entry || '0'));
    entry = Number.isFinite(result) ? String(Number(result.toPrecision(11))) : 'Ошибка';
    operator = undefined;
    replace = true;
  }
  function press(key) {
    if (busy) return;
    if (key === 'clear') {
      resetEntry();
      message();
      return;
    }
    if (key === '=') {
      if (!operator && !replace && configured && isFieldUnlockPin(entry)) {
        void tryPin(entry);
        return;
      }
      if (operator) calculate();
      else replace = true;
    } else if (Object.hasOwn(operation,key)) {
      if (operator && entry) calculate();
      left = Number(entry || '0');
      if (!Number.isFinite(left)) { resetEntry(); return; }
      operator = key;
      entry = '';
      replace = false;
    } else if (key === 'backspace') {
      entry = entry.slice(0,-1);
    } else if (key === 'percent') {
      entry = String(Number(entry || '0') / 100);
      replace = true;
    } else if (/^[0-9.]$/.test(key)) {
      if (replace) entry = '';
      replace = false;
      if (entry.length < 32 && (key !== '.' || !entry.includes('.'))) entry += key;
    }
    display();
  }

  workspace.inert = true;
  for (const button of calculator.querySelectorAll('[data-key]')) {
    button.addEventListener('click',() => press(button.dataset.key));
  }
  document.addEventListener('keydown',event => {
    if (unlocked || calculator.hidden || event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === 'Enter' && event.target?.matches?.('button')) {
      if (!event.target.matches('[data-key]')) return;
    }
    const keys = {Enter:'=',Escape:'clear',Backspace:'backspace','%':'percent'};
    const key = keys[event.key] || event.key;
    if (/^[\d.+*/=\-]$/.test(key) || Object.hasOwn(keys,event.key)) {
      event.preventDefault();
      press(key);
    }
  });
  for (const event of ['pointerdown','keydown','touchstart']) {
    document.addEventListener(event,activity,{passive:true});
  }
  id('privacy-setup-open').addEventListener('click',() => showForm(false));
  id('privacy-recovery-open').addEventListener('click',() => showForm(true));
  id('privacy-cancel').addEventListener('click',() => { if (!busy) { showCalculator(); message(); } });
  id('privacy-enter').addEventListener('click',() => { if (pendingKey) unlock(pendingKey); });
  id('privacy-copy-recovery').addEventListener('click',async () => {
    const value = id('privacy-recovery-value').textContent;
    if (!pendingKey || !value) return;
    try {
      await navigator.clipboard.writeText(value);
      if (pendingKey) message('Код скопирован.');
    } catch {
      if (pendingKey) message('Выдели и скопируй код вручную.');
    }
  });
  id('lock-now').addEventListener('click',lock);
  form.addEventListener('submit',async event => {
    event.preventDefault();
    if (busy || !security) return;
    const pin = id('privacy-pin').value;
    if (pin !== id('privacy-pin-confirm').value) { message('Коды не совпадают.'); return; }
    const current = revision;
    busy = true;
    id('privacy-submit').disabled = true;
    message('Готовим защиту…');
    try {
      if (recovering) {
        const key = await security.recover(id('privacy-recovery').value,pin);
        if (current === revision) unlock(key);
        return;
      }
      const {key,recoveryCode} = await security.setup(pin);
      configured = true;
      buttons();
      if (current !== revision) return;
      form.reset();
      form.hidden = true;
      recoveryCard.hidden = false;
      id('privacy-recovery-value').textContent = recoveryCode;
      pendingKey = key;
      message();
      id('privacy-enter').focus();
    } catch (error) {
      if (current === revision) report(error);
    } finally {
      busy = false;
      id('privacy-submit').disabled = false;
    }
  });
  void openFieldSecurity().then(async stored => {
    configured = await stored.configured();
    security = stored;
    buttons();
    message();
  }).catch(report);

  return {lock,activity,isUnlocked:() => unlocked};
}
