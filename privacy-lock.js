import {isFieldUnlockPin,openFieldSecurity} from './field-security.js';
import {createCalculator} from './calculator.js';

const id = value => document.getElementById(value);
const inactivity = 5 * 60 * 1000;
const failure = {
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
  const setupButton = id('privacy-setup-open');
  const workspace = document.querySelector('.workspace');
  const status = id('privacy-status');
  const math = createCalculator();
  const clear = calculator.querySelector('[data-key=clear]');
  const operations = calculator.querySelectorAll('.calc-operation');
  let security;
  let securityError;
  let configured = false;
  let unlocked = false;
  let busy = false;
  let revision = 0;
  let recovering = false;
  let nextAttempt;
  let checking = false;
  let idleTimer;
  let hold;

  function message(text = '') { status.textContent = text; }
  function display() {
    const {value,expression,operator} = math.read();
    const output = id('calculator-display');
    output.textContent = value;
    output.dataset.long = String(value.length > 9);
    id('calculator-expression').textContent = expression;
    for (const button of operations) button.dataset.selected = String(button.dataset.key === operator);
  }
  function showCalculator() {
    form.reset();
    form.hidden = true;
    id('privacy-recovery-value').textContent = '';
    recoveryCard.hidden = true;
    calculator.hidden = false;
    setupButton.hidden = configured || (!security && !securityError);
    math.reset();
    display();
  }
  function returnToCalculator() {
    showCalculator();
    message();
    screen.focus({preventScroll:true});
  }
  function showAccessForm(focusInput = true) {
    if (busy || unlocked || calculator.hidden) return;
    revision += 1;
    nextAttempt = undefined;
    recovering = configured;
    calculator.hidden = true;
    math.reset();
    display();
    id('privacy-recovery-label').hidden = !recovering;
    id('privacy-recovery').required = recovering;
    id('privacy-form-title').textContent = recovering ? 'Восстановление доступа' : 'Придумай PIN для карт';
    id('privacy-form-intro').textContent = recovering
      ? 'Введи сохранённый код восстановления и новый PIN из 4–20 цифр. Для входа набери новый PIN на калькуляторе и нажми «=».'
      : 'Введи PIN из 4–20 цифр дважды. Затем набери его на калькуляторе и нажми «=».';
    id('privacy-submit').textContent = recovering ? 'Сменить PIN' : 'Создать PIN';
    id('privacy-submit').disabled = !security;
    id('privacy-cancel').textContent = recovering ? 'Отмена' : 'К калькулятору';
    form.hidden = false;
    if (securityError) report(securityError);
    else message();
    if (focusInput) id(recovering ? 'privacy-recovery' : 'privacy-pin').focus();
    else form.focus({preventScroll:true});
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
    clearTimeout(hold);
    nextAttempt = undefined;
    const wasUnlocked = unlocked;
    unlocked = false;
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    workspace.inert = true;
    workspace.hidden = true;
    screen.hidden = false;
    returnToCalculator();
    if (wasUnlocked) onLock();
  }
  function report(error) {
    if (error?.code === 'cooldown') {
      const seconds = Math.max(1,Math.ceil((error.retryAt - Date.now()) / 1000));
      message('Повтори попытку через ' + seconds + ' с.');
    } else message(failure[error?.code] || 'Не удалось открыть защищённые данные.');
  }

  async function tryPin(pin) {
    if (!security || !configured) return;
    nextAttempt = {pin,revision};
    if (checking) return;
    checking = true;
    try {
      while (nextAttempt) {
        const attempt = nextAttempt;
        nextAttempt = undefined;
        const key = await security.unlock(attempt.pin).catch(() => null);
        // A normal calculation or a different screen supersedes a previous entry.
        if (key && attempt.revision === revision && !calculator.hidden) unlock(key);
      }
    } finally { checking = false; }
  }

  function press(key) {
    if (unlocked || calculator.hidden) return;
    const candidate = math.press(key);
    // A second press of equals on a submitted number leaves its check pending.
    if (key !== '=' || candidate !== null) {
      revision += 1;
      nextAttempt = undefined;
    }
    display();
    if (isFieldUnlockPin(candidate)) void tryPin(candidate);
  }

  workspace.inert = true;
  const configuration = openFieldSecurity().then(async stored => {
    configured = await stored.configured();
    security = stored;
    setupButton.hidden = configured;
    if (!configured && !document.hidden) showAccessForm(false);
  }).catch(error => {
    securityError = error;
    setupButton.hidden = configured;
  });
  for (const button of calculator.querySelectorAll('[data-key]')) {
    button.addEventListener('click',() => press(button.dataset.key));
  }
  clear.addEventListener('pointerdown',event => {
    if (event.button !== 0 || !event.isPrimary) return;
    hold = setTimeout(() => void configuration.then(showAccessForm),850);
  });
  for (const event of ['pointerup','pointerleave','pointercancel','lostpointercapture']) {
    clear.addEventListener(event,() => clearTimeout(hold));
  }
  clear.addEventListener('contextmenu',event => event.preventDefault());
  document.addEventListener('keydown',event => {
    if (unlocked || calculator.hidden || event.metaKey || event.ctrlKey) return;
    if (event.altKey) {
      if (event.key === 'Backspace') {
        event.preventDefault();
        void configuration.then(showAccessForm);
      }
      return;
    }
    const keys = {Enter:'=',Escape:'clear',Backspace:'backspace','%':'percent'};
    const key = keys[event.key] || event.key;
    if (/^[\d.,+*/=\-]$/.test(key) || Object.hasOwn(keys,event.key)) {
      event.preventDefault();
      press(key);
    }
  });
  for (const event of ['pointerdown','keydown','touchstart']) {
    document.addEventListener(event,activity,{passive:true});
  }
  setupButton.addEventListener('click',() => void configuration.then(() => {
    if (!configured) showAccessForm();
  }));
  id('privacy-cancel').addEventListener('click',() => { if (!busy) returnToCalculator(); });
  id('privacy-continue').addEventListener('click',() => { if (!recoveryCard.hidden) returnToCalculator(); });
  id('privacy-copy-recovery').addEventListener('click',async () => {
    const output = id('privacy-recovery-value');
    const value = output.textContent;
    if (recoveryCard.hidden || !value) return;
    try {
      await navigator.clipboard.writeText(value);
      if (output.textContent === value) message('Код скопирован.');
    } catch {
      if (output.textContent === value) message('Выдели и скопируй код вручную.');
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
        await security.recover(id('privacy-recovery').value,pin);
        if (current === revision) returnToCalculator();
        return;
      }
      const {recoveryCode} = await security.setup(pin);
      configured = true;
      setupButton.hidden = true;
      if (current !== revision) return;
      form.reset();
      form.hidden = true;
      recoveryCard.hidden = false;
      id('privacy-recovery-value').textContent = recoveryCode;
      message();
      id('privacy-continue').focus();
    } catch (error) {
      if (error?.code === 'already-configured') {
        configured = true;
        setupButton.hidden = true;
      }
      if (current === revision) report(error);
    } finally {
      busy = false;
      id('privacy-submit').disabled = false;
    }
  });
  return {lock,activity,isUnlocked:() => unlocked};
}
