// @ts-check
export const phoneChecks = Object.freeze(['startup','gps','field','return','lock','battery']);
export const PHONE_REQUIRED = 'ТРЕБУЕТСЯ ПРОВЕРКА НА ТЕЛЕФОНЕ';
export const FOREST_NOT_READY = 'НЕ ГОТОВО ДЛЯ ИСПОЛЬЗОВАНИЯ В ЛЕСУ';
export const PHONE_CHECKED = 'ОФЛАЙН-ПРОВЕРКА ВЫПОЛНЕНА';

/** @typedef {{version:string,checks:string[]}} PhoneReceipt */

/** @param {{version:string,ready:boolean,receipt?:PhoneReceipt|null}} state */
export function readinessOverall({version,ready,receipt}) {
  const checked = Boolean(version && receipt?.version === version &&
    Array.isArray(receipt.checks) && phoneChecks.every(item => receipt.checks.includes(item)));
  const verified = checked && ready;
  return {
    overall:verified ? PHONE_CHECKED : FOREST_NOT_READY,
    phone:verified ? 'VERIFIED' : checked ? 'PARTIAL' : 'NOT TESTED',
    phoneLabel:verified ? 'Пользователь подтвердил проверку на телефоне' : PHONE_REQUIRED,
  };
}
