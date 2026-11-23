const arithmetic = {
  '+':(a,b) => a + b,
  '-':(a,b) => a - b,
  '*':(a,b) => a * b,
  '/':(a,b) => a / b,
};
const symbols = {'+':'+','-':'−','*':'×','/':'÷'};
const inputLimit = 32;

function display(value) {
  if (typeof value === 'number') {
    const rounded = Number(value.toPrecision(14));
    value = String(Number.isFinite(rounded) ? rounded : value);
  }
  return value.replace('.',',');
}

// Operations are applied in order. Repeated equals reuses the last effective right operand.
export function createCalculator() {
  let entry,left,operator,expression,lastStep,canSubmit,sealed;
  reset();

  function reset() {
    // Strings are editable input, numbers are results, and null is an arithmetic error.
    entry = '';
    left = 0;
    operator = null;
    expression = '';
    lastStep = null;
    canSubmit = true;
    sealed = false;
  }

  function fail() {
    reset();
    entry = null;
  }

  function typeKey(key) {
    if (typeof entry !== 'string' || sealed) {
      entry = '';
      canSubmit = operator === null;
      sealed = false;
    }
    if (entry.length >= inputLimit) return;
    lastStep = null;
    if (key === '.') {
      if (!entry.includes('.')) entry = (entry || '0') + '.';
      canSubmit = false;
    } else {
      entry = entry === '-0' ? '-' + key : entry + key;
    }
    expression = '';
  }

  function backspace() {
    if (entry === null) { reset(); return; }
    if (typeof entry !== 'string' || sealed) return;
    entry = entry.slice(0,-1);
    if (entry === '-') entry = '';
    if (!entry && operator === null) reset();
  }

  function negate() {
    if (entry === null) return;
    if (typeof entry === 'number') entry = -entry;
    else if (entry.startsWith('-')) entry = entry.slice(1);
    else entry = '-' + (entry || '0');
    expression = '±';
    lastStep = null;
    canSubmit = false;
    sealed = false;
  }

  function percent() {
    if (entry === null || entry === '') return;
    const previous = Number(entry);
    const fraction = previous / 100;
    const value = operator === '+' || operator === '-' ? left * fraction : fraction;
    if (!Number.isFinite(value)) { fail(); return; }
    entry = value;
    expression = display(previous) + ' %';
    lastStep = null;
    canSubmit = false;
    sealed = false;
  }

  function choose(next) {
    if (entry === null) return;
    if (!operator) left = Number(entry);
    else if (entry !== '') left = arithmetic[operator](left,Number(entry));
    if (!Number.isFinite(left)) { fail(); return; }
    operator = next;
    entry = '';
    expression = '';
    lastStep = null;
    canSubmit = false;
    sealed = false;
  }

  function complete(action,start,operand) {
    const value = arithmetic[action](start,operand);
    if (!Number.isFinite(value)) { fail(); return; }
    entry = value;
    operator = null;
    expression = display(start) + ' ' + symbols[action] + ' ' + display(operand) + ' =';
    lastStep = {action,operand};
    canSubmit = false;
  }

  function equals() {
    if (entry === null || entry === '') return null;
    if (operator) complete(operator,left,Number(entry));
    else if (lastStep) complete(lastStep.action,Number(entry),lastStep.operand);
    else if (typeof entry === 'string' && !sealed) {
      // Keep a standalone code out of the displayed expression and never convert it to Number.
      const code = canSubmit && /^\d+$/.test(entry) ? entry : null;
      sealed = true;
      canSubmit = false;
      return code;
    }
    return null;
  }

  function press(key) {
    if (typeof key !== 'string') return null;
    if (key === '=') return equals();
    if (key === 'clear') reset();
    else if (key === 'backspace') backspace();
    else if (key === 'sign') negate();
    else if (key === 'percent') percent();
    else if (Object.hasOwn(arithmetic,key)) choose(key);
    else if (/^[0-9.,]$/.test(key)) typeKey(key === ',' ? '.' : key);
    return null;
  }

  return {
    press,reset,
    read() {
      return {
        value:entry === null ? 'Ошибка' : display(entry === '' ? (operator ? left : 0) : entry),
        expression:operator ? display(left) + ' ' + symbols[operator] : expression,
        operator,
      };
    },
  };
}
