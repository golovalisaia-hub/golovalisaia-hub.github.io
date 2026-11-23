import {fieldError, fieldTransaction, openFieldDatabase} from './field-db.js';

const VERSION = 1;
const SECURITY_DB = 'quiet-maps-field-security';
const CONFIG = 'settings';
const ACTIVE = 'active';
const RECORDS = 'records';
const RECORDS_DB = 'quiet-maps-field-records';
const PHOTO_TYPES = ['image/jpeg','image/png','image/webp'];
export const FIELD_PHOTO_MAX_BYTES = 6 * 1024 * 1024;
const ITERATIONS = 1200000;
const KEY_BYTES = 32;
const SALT_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ATTEMPT_LIMIT = 5;
const FIRST_DELAY_MS = 30000;
const MAX_DELAY_MS = 30 * 60 * 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal:true});
const emptyAttempts = () => ({failures:0, retryAt:0});
const aes = {name:'AES-GCM', length:256};
const aesUsages = ['encrypt', 'decrypt'];

const randomBytes = length => crypto.getRandomValues(new Uint8Array(length));
const bytesOfLength = (value, length) => value instanceof Uint8Array && value.length === length;
// Already configured devices can have a PIN of up to 32 digits.
export const isFieldUnlockPin = pin => typeof pin === 'string' && /^\d{4,32}$/.test(pin);

const isNewFieldPin = pin => isFieldUnlockPin(pin) && pin.length <= 20;

function recoverySecret() {
  const bytes = randomBytes(16);
  try {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  } finally {
    bytes.fill(0);
  }
}

function normalizeRecovery(code) {
  if (typeof code !== 'string' || code.length > 80) return null;
  const secret = code.replace(/[\s-]/g, '').toUpperCase();
  return /^[0-9A-F]{32}$/.test(secret) ? secret : null;
}

async function deriveProtectionKey(secret, salt) {
  const bytes = encoder.encode(secret);
  let material;
  try {
    material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
  } finally {
    bytes.fill(0);
  }
  return crypto.subtle.deriveKey({name:'PBKDF2', hash:'SHA-256', salt, iterations:ITERATIONS},
    material, aes, false, aesUsages);
}

function gcm(iv, binding) {
  return {name:'AES-GCM', iv, tagLength:128,
    additionalData:encoder.encode(JSON.stringify(['quiet-maps-field', VERSION, ...binding]))};
}

async function sealBytes(key, binding, bytes) {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(gcm(iv, binding), key, bytes));
  return {iv, ciphertext};
}

async function openBytes(key, binding, envelope) {
  if (!bytesOfLength(envelope?.iv, IV_BYTES) || !(envelope.ciphertext instanceof Uint8Array) ||
      envelope.ciphertext.length < TAG_BYTES) throw fieldError('field-corrupt');
  return new Uint8Array(await crypto.subtle.decrypt(gcm(envelope.iv, binding), key, envelope.ciphertext));
}

export async function sealFieldValue(key, binding, value) {
  const json = JSON.stringify(value);
  if (typeof json !== 'string') throw fieldError('invalid-record');
  const bytes = encoder.encode(json);
  try {
    return await sealBytes(key, binding, bytes);
  } finally {
    bytes.fill(0);
  }
}

export async function openFieldValue(key, binding, envelope) {
  let bytes;
  try {
    bytes = await openBytes(key, binding, envelope);
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw fieldError('field-corrupt');
  } finally {
    bytes?.fill(0);
  }
}

function importFieldKey(raw) {
  return crypto.subtle.importKey('raw', raw, aes, false, aesUsages);
}

async function wrapKey(secret, raw, binding) {
  const salt = randomBytes(SALT_BYTES);
  const protector = await deriveProtectionKey(secret, salt);
  return {salt, ...await sealBytes(protector, binding, raw)};
}

function credentialBinding(config, type) {
  return type === 'pin' ? ['pin-key', config.id, config.revision] : ['recovery-key', config.id];
}

async function unwrapKey(config, type, secret) {
  const wrap = config[type];
  const protector = await deriveProtectionKey(secret, wrap.salt);
  try {
    return await openBytes(protector, credentialBinding(config, type), wrap);
  } catch {
    throw fieldError(type === 'pin' ? 'wrong-pin' : 'wrong-recovery');
  }
}

function isEnvelope(envelope, length) {
  return bytesOfLength(envelope?.iv, IV_BYTES) && bytesOfLength(envelope?.ciphertext, length + TAG_BYTES);
}

function isWrapper(wrap) {
  return bytesOfLength(wrap?.salt, SALT_BYTES) && isEnvelope(wrap, KEY_BYTES);
}

function hasAttempts(state) {
  return Number.isSafeInteger(state?.failures) && state.failures >= 0 &&
    Number.isSafeInteger(state?.retryAt) && state.retryAt >= 0;
}

function requireConfig(config) {
  if (config === undefined) throw fieldError('not-configured');
  if (config?.version !== VERSION || typeof config.id !== 'string' || typeof config.revision !== 'string' ||
      !isEnvelope(config.proof, 0) || !isWrapper(config.pin) ||
      (config.recovery !== null && !isWrapper(config.recovery)) ||
      !hasAttempts(config.attempts?.pin) || !hasAttempts(config.attempts?.recovery)) throw fieldError('field-corrupt');
  return config;
}

async function authenticateKey(config, key, code = 'field-corrupt') {
  try {
    const proof = await openBytes(key, ['key-proof', config.id], config.proof);
    if (proof.length !== 0) throw fieldError(code);
  } catch {
    throw fieldError(code);
  }
}

const configurationDatabase = () => openFieldDatabase(SECURITY_DB, VERSION, db => db.createObjectStore(CONFIG));

function getConfig(db) {
  return fieldTransaction(db, [CONFIG], 'readonly', ([settings], read, done) => read(settings.get(ACTIVE), done));
}

function changeConfig(db, update) {
  return fieldTransaction(db, [CONFIG], 'readwrite', ([settings], read, done) => {
    read(settings.get(ACTIVE), stored => {
      const config = update(stored);
      settings.put(config, ACTIVE);
      done(config);
    });
  });
}

function reserveAttempt(db, type) {
  // Reserve before deriving the key so parallel requests and page reloads share the same budget.
  return changeConfig(db, stored => {
    const config = requireConfig(stored);
    if (!config[type]) throw fieldError('recovery-unavailable');
    const now = Date.now();
    const attempt = config.attempts[type];
    if (attempt.retryAt > now) throw fieldError('cooldown', {retryAt:attempt.retryAt});
    const failures = Math.min(ATTEMPT_LIMIT + 6, attempt.failures + 1);
    const delay = failures < ATTEMPT_LIMIT ? 0 : Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** (failures - ATTEMPT_LIMIT));
    config.attempts[type] = {failures, retryAt:delay ? now + delay : 0};
    return config;
  });
}

function requireUnchanged(config, snapshot) {
  if (config?.id !== snapshot.id || config.revision !== snapshot.revision) throw fieldError('credentials-changed');
  return requireConfig(config);
}

/**
 * Setup can reject with invalid-pin or already-configured. Unlock and recovery
 * report wrong-pin, wrong-recovery, cooldown, recovery-unavailable, or
 * credentials-changed. A cooldown includes retryAt in epoch milliseconds.
 * Missing or damaged configuration reports not-configured or field-corrupt.
 */
export async function openFieldSecurity() {
  const db = await configurationDatabase();
  return {
    async configured() {
      const config = await getConfig(db);
      return config === undefined ? false : Boolean(requireConfig(config));
    },
    async setup(pin, {recovery = true} = {}) {
      if (!isNewFieldPin(pin)) throw fieldError('invalid-pin');
      if (await getConfig(db) !== undefined) throw fieldError('already-configured');
      const raw = randomBytes(KEY_BYTES);
      try {
        const key = await importFieldKey(raw);
        const config = {version:VERSION, id:crypto.randomUUID(), revision:crypto.randomUUID(),
          attempts:{pin:emptyAttempts(), recovery:emptyAttempts()}};
        const secret = recovery ? recoverySecret() : null;
        [config.pin, config.recovery, config.proof] = await Promise.all([
          wrapKey(pin, raw, credentialBinding(config, 'pin')),
          secret ? wrapKey(secret, raw, credentialBinding(config, 'recovery')) : null,
          sealBytes(key, ['key-proof', config.id], new Uint8Array()),
        ]);
        await changeConfig(db, stored => {
          if (stored !== undefined) throw fieldError('already-configured');
          return config;
        });
        return {key, recoveryCode:secret?.match(/.{4}/g).join('-') ?? null};
      } finally {
        raw.fill(0);
      }
    },
    async unlock(pin) {
      const config = await reserveAttempt(db, 'pin');
      if (!isFieldUnlockPin(pin)) throw fieldError('wrong-pin');
      const raw = await unwrapKey(config, 'pin', pin);
      try {
        const key = await importFieldKey(raw);
        await authenticateKey(config, key);
        await changeConfig(db, stored => {
          const current = requireUnchanged(stored, config);
          current.attempts.pin = emptyAttempts();
          return current;
        });
        return key;
      } finally {
        raw.fill(0);
      }
    },
    async recover(code, pin) {
      if (!isNewFieldPin(pin)) throw fieldError('invalid-pin');
      const config = await reserveAttempt(db, 'recovery');
      const secret = normalizeRecovery(code);
      if (!secret) throw fieldError('wrong-recovery');
      const raw = await unwrapKey(config, 'recovery', secret);
      try {
        const key = await importFieldKey(raw);
        await authenticateKey(config, key);
        const revision = crypto.randomUUID();
        const wrapped = await wrapKey(pin, raw, credentialBinding({...config, revision}, 'pin'));
        await changeConfig(db, stored => {
          const current = requireUnchanged(stored, config);
          return {...current, revision, pin:wrapped, attempts:{pin:emptyAttempts(), recovery:emptyAttempts()}};
        });
        return key;
      } finally {
        raw.fill(0);
      }
    },
  };
}

/** Invalid CryptoKeys report invalid-key. A different valid key reports wrong-key. */
export async function verifyFieldKey(key) {
  if (!(key instanceof CryptoKey) || key.type !== 'secret' || key.algorithm.name !== aes.name ||
      key.algorithm.length !== aes.length || key.extractable || !aesUsages.every(usage => key.usages.includes(usage))) {
    throw fieldError('invalid-key');
  }
  const db = await configurationDatabase();
  try {
    const config = requireConfig(await getConfig(db));
    await authenticateKey(config, key, 'wrong-key');
    return config.id;
  } finally {
    db.close();
  }
}

function requireId(id) {
  if (typeof id !== 'string' || id.length < 1 || id.length > 200) throw fieldError('invalid-id');
}

function photoFormat(bytes) {
  const asciiAt = (offset,text) => [...text].every((character,index) => bytes[offset + index] === character.charCodeAt(0));
  if (bytes.length >= 8 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 0;
  if (bytes.length >= 24 && [137,80,78,71,13,10,26,10].every((byte,index) => bytes[index] === byte) &&
      asciiAt(12,'IHDR')) return 1;
  if (bytes.length >= 20 && asciiAt(0,'RIFF') && asciiAt(8,'WEBP') &&
      ['VP8 ','VP8L','VP8X'].some(tag => asciiAt(12,tag))) return 2;
  return -1;
}

async function sealRecordPhoto(key, binding, file) {
  if (!(file instanceof Blob) || !file.size || file.size > FIELD_PHOTO_MAX_BYTES) throw fieldError('photo-size');
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    if (photoFormat(bytes) < 0) throw fieldError('photo-format');
    const {iv,ciphertext} = await sealBytes(key,binding,bytes);
    return {iv,ciphertext:new Blob([ciphertext])};
  } finally {
    bytes.fill(0);
  }
}

async function openRecordPhoto(key, binding, envelope) {
  let bytes;
  try {
    const content = envelope?.ciphertext;
    if (!(content instanceof Blob) || content.size <= TAG_BYTES ||
        content.size > FIELD_PHOTO_MAX_BYTES + TAG_BYTES) throw fieldError('field-corrupt');
    const ciphertext = new Uint8Array(await content.arrayBuffer());
    bytes = await openBytes(key,binding,{iv:envelope.iv,ciphertext});
    const type = PHOTO_TYPES[photoFormat(bytes)];
    if (!type) throw fieldError('field-corrupt');
    return new Blob([bytes],{type});
  } catch {
    throw fieldError('field-corrupt');
  } finally {
    bytes?.fill(0);
  }
}

function recordVersion(record) {
  if (!record) return null;
  return bytesOfLength(record.iv,IV_BYTES) ? Array.from(record.iv).join('.') : 'damaged';
}

/**
 * Stores JSON-serializable data. Use opaque IDs because lookup keys are visible
 * in IndexedDB. An unreadable authenticated record reports field-corrupt.
 * The unchanged v1 store accepts a photo as an independently authenticated
 * ciphertext Blob on the record. Earlier readers can still open the record.
 */
export async function openFieldRecords(key) {
  const fieldId = await verifyFieldKey(key);
  const db = await openFieldDatabase(RECORDS_DB, VERSION, opened => opened.createObjectStore(RECORDS, {keyPath:'id'}));
  const transact = (mode, work) => fieldTransaction(db,[RECORDS],mode,work);
  const binding = id => [fieldId, 'record', id];
  const photoBinding = (id, ref) => [fieldId, 'record-photo', id, ref];
  function compare(record, expectedVersion) {
    if (expectedVersion !== undefined && recordVersion(record) !== expectedVersion) throw fieldError('record-changed');
  }

  return {
    close() { db.close(); },
    async get(id) {
      requireId(id);
      const record = await transact('readonly', ([records], read, done) => read(records.get(id), done));
      return record ? openFieldValue(key, binding(id), record) : null;
    },
    async list({includeDamaged = false, includeVersion = false} = {}) {
      const records = await transact('readonly', ([table], read, done) => read(table.getAll(), done));
      return Promise.all(records.map(async record => {
        const meta = {id:record.id};
        if (includeVersion) meta.version = recordVersion(record);
        try {
          return {...meta,value:await openFieldValue(key,binding(record.id),record)};
        } catch (error) {
          if (includeDamaged && error.code === 'field-corrupt') return {...meta,damaged:true};
          throw error;
        }
      }));
    },
    async getPhoto(id) {
      requireId(id);
      const record = await transact('readonly', ([records], read, done) => read(records.get(id),done));
      if (!record) return null;
      const {photoRef} = await openFieldValue(key, binding(id), record);
      if (!photoRef) return null;
      return openRecordPhoto(key,photoBinding(id,photoRef),record.photo);
    },
    async put(id, value, {photo,expectedVersion} = {}) {
      requireId(id);
      let attachment;
      if (photo !== undefined) {
        value = {...value};
        delete value.photoRef;
        if (photo !== null) {
          value.photoRef = crypto.randomUUID();
          attachment = await sealRecordPhoto(key,photoBinding(id,value.photoRef),photo);
        }
      }
      const envelope = await sealFieldValue(key,binding(id),value);
      await transact('readwrite', ([records], read) => {
        read(records.get(id), current => {
          compare(current,expectedVersion);
          const file = attachment ?? (typeof value?.photoRef === 'string' ? current?.photo : undefined);
          records.put(file ? {id, ...envelope, photo:file} : {id, ...envelope});
        });
      });
    },
    async remove(id, {expectedVersion} = {}) {
      requireId(id);
      return transact('readwrite', ([records], read, done) => {
        read(records.get(id), current => {
          compare(current,expectedVersion);
          if (current) records.delete(id);
          done(Boolean(current));
        });
      });
    },
  };
}
