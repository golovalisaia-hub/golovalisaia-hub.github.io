export const MAX_PHOTO_BYTES = 20 * 1024 * 1024
export const MAX_VAULT_BYTES = 128 * 1024 * 1024
export const MAX_RECORDS = 400
export const TAG_BYTES = 16

const VERSION = 1
const ITERATIONS = 1_200_000
const IV_BYTES = 12
const SALT_BYTES = 32
const METADATA_LIMIT = 8 * 1024
const MANIFEST_LIMIT = MAX_RECORDS * 35 + 32
const BACKUP_LIMIT = MAX_VAULT_BYTES + MAX_RECORDS * (METADATA_LIMIT + 64) + MANIFEST_LIMIT + 116
const BACKUP_HEADER_BYTES = 116
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const marker = encoder.encode('private-vault-v1')
const magic = encoder.encode('QMVAULT1')
const idPattern = /^[a-f0-9]{32}$/

export class VaultError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length))
}

function toHex(bytes) {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}

function idBytes(id) {
  return Uint8Array.from(id.match(/../g), pair => Number.parseInt(pair, 16))
}

function hasBytes(value, length) {
  return value instanceof Uint8Array && value.length === length
}

function equalBytes(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function validPassword(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    !/[\p{Surrogate}\u0000-\u001f\u007f]/u.test(value)
}

export function isStrongPassword(value) {
  if (!validPassword(value)) return false
  const compact = value.replace(/\s/gu, '').toLowerCase()
  return Array.from(compact).length >= 20 && new Set(compact).size >= 10 &&
    !/^(.+)\1+$/u.test(compact)
}

export function generatePassword() {
  let value
  do {
    value = btoa(String.fromCharCode(...randomBytes(24))).replace(/\+/g, '-').replace(/\//g, '_')
  } while (!isStrongPassword(value))
  return value
}

async function deriveKey(password, salt) {
  if (!validPassword(password)) throw new VaultError('password')
  const bytes = encoder.encode(password)
  let inputKey
  try {
    inputKey = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey'])
  } finally {
    bytes.fill(0)
  }
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    inputKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

function algorithm({ config }, kind, id, iv) {
  return {
    name: 'AES-GCM',
    iv,
    tagLength: 128,
    additionalData: encoder.encode(['quiet-maps', config.version, config.vaultId, kind, id].join('\0'))
  }
}

async function seal(session, kind, id, bytes) {
  const iv = randomBytes(IV_BYTES)
  const ciphertext = await crypto.subtle.encrypt(algorithm(session, kind, id, iv), session.key, bytes)
  return { iv, ciphertext: new Uint8Array(ciphertext) }
}

async function open(session, kind, id, { iv, ciphertext }) {
  return new Uint8Array(await crypto.subtle.decrypt(algorithm(session, kind, id, iv), session.key, ciphertext))
}

function validConfig(config) {
  return config?.version === VERSION && typeof config.vaultId === 'string' && idPattern.test(config.vaultId) &&
    hasBytes(config.salt, SALT_BYTES) && hasBytes(config.check?.iv, IV_BYTES) &&
    hasBytes(config.check?.ciphertext, marker.length + TAG_BYTES)
}

export async function createVault(password) {
  if (!isStrongPassword(password)) throw new VaultError('weak-password')
  const config = { version: VERSION, vaultId: toHex(randomBytes(16)), salt: randomBytes(SALT_BYTES) }
  const session = { config, key: await deriveKey(password, config.salt) }
  config.check = await seal(session, 'check', '', marker)
  return session
}

export async function unlockVault(config, password) {
  if (!validConfig(config)) throw new VaultError('config')
  const session = { config, key: await deriveKey(password, config.salt) }
  try {
    const plaintext = await open(session, 'check', '', config.check)
    const valid = equalBytes(plaintext, marker)
    plaintext.fill(0)
    if (!valid) throw new VaultError('password')
  } catch {
    throw new VaultError('password')
  }
  return session
}

function asciiAt(bytes, offset, value) {
  return offset + value.length <= bytes.length &&
    Array.from(value).every((character, index) => bytes[offset + index] === character.charCodeAt(0))
}

function identifyPhoto(bytes) {
  if (bytes.length >= 8 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.length >= 24 && equalBytes(bytes.subarray(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]) &&
      asciiAt(bytes, 12, 'IHDR')) return 'image/png'
  if (bytes.length >= 20 && asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP') &&
      ['VP8 ', 'VP8L', 'VP8X'].some(kind => asciiAt(bytes, 12, kind))) return 'image/webp'
  if (bytes.length < 16 || !asciiAt(bytes, 4, 'ftyp')) return ''
  const boxLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
  if (boxLength < 16 || boxLength > Math.min(bytes.length, 1024) || boxLength % 4 !== 0) return ''
  const avif = ['avif', 'avis']
  const heic = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']
  const heif = ['mif1', 'msf1']
  if (avif.some(brand => asciiAt(bytes, 8, brand))) return 'image/avif'
  if (heic.some(brand => asciiAt(bytes, 8, brand))) return 'image/heic'
  if (!heif.some(brand => asciiAt(bytes, 8, brand))) return ''
  for (let offset = 16; offset < boxLength; offset += 4) {
    if (avif.some(brand => asciiAt(bytes, offset, brand))) return 'image/avif'
    if (heic.some(brand => asciiAt(bytes, offset, brand))) return 'image/heic'
  }
  return 'image/heif'
}

export function storedPhotoSize(record) {
  const content = record?.photo?.ciphertext
  const length = content instanceof Uint8Array ? content.byteLength :
    content instanceof Blob && content.type === '' ? content.size : 0
  return length > TAG_BYTES && length <= MAX_PHOTO_BYTES + TAG_BYTES ? length - TAG_BYTES : 0
}

function validRecord(record) {
  return typeof record?.id === 'string' && idPattern.test(record.id) &&
    hasBytes(record.metadata?.iv, IV_BYTES) && hasBytes(record.photo?.iv, IV_BYTES) &&
    record.metadata.ciphertext instanceof Uint8Array &&
    record.metadata.ciphertext.length > TAG_BYTES && record.metadata.ciphertext.length <= METADATA_LIMIT &&
    storedPhotoSize(record) > 0
}

export async function sealPhoto(session, file, assertActive = () => {}) {
  if (!(file instanceof Blob) || file.size === 0 || file.size > MAX_PHOTO_BYTES) throw new VaultError('photo-size')
  const bytes = new Uint8Array(await file.arrayBuffer())
  try {
    assertActive()
    const type = identifyPhoto(bytes)
    if (!type) throw new VaultError('photo-format')
    const id = toHex(randomBytes(16))
    const metadata = {
      name: String(file.name || 'Фото').slice(0, 1024),
      type,
      size: bytes.length,
      lastModified: Number.isSafeInteger(file.lastModified) ? file.lastModified : 0
    }
    const encodedMetadata = encoder.encode(JSON.stringify(metadata))
    try {
      const sealedMetadata = await seal(session, 'metadata', id, encodedMetadata)
      assertActive()
      const photo = await seal(session, 'photo', id, bytes)
      assertActive()
      return {
        id,
        metadata: sealedMetadata,
        photo: { iv: photo.iv, ciphertext: new Blob([photo.ciphertext]) }
      }
    } finally {
      encodedMetadata.fill(0)
    }
  } finally {
    bytes.fill(0)
  }
}

export async function openMetadata(session, record) {
  if (!validRecord(record)) throw new VaultError('record')
  const bytes = await open(session, 'metadata', record.id, record.metadata)
  try {
    const metadata = JSON.parse(decoder.decode(bytes))
    const types = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif']
    if (typeof metadata?.name !== 'string' || metadata.name.length === 0 || metadata.name.length > 1024 ||
        !types.includes(metadata.type) || metadata.size !== storedPhotoSize(record) ||
        !Number.isSafeInteger(metadata.lastModified)) throw new VaultError('record')
    return metadata
  } finally {
    bytes.fill(0)
  }
}

async function decryptPhoto(session, record, metadata, assertActive) {
  const content = record.photo.ciphertext
  const ciphertext = content instanceof Blob ? await content.arrayBuffer() : content
  assertActive()
  const bytes = await open(session, 'photo', record.id, { iv: record.photo.iv, ciphertext })
  try {
    assertActive()
    if (identifyPhoto(bytes) !== metadata.type) throw new VaultError('photo-format')
    return bytes
  } catch (error) {
    bytes.fill(0)
    throw error
  }
}

export async function openPhoto(session, record, assertActive = () => {}) {
  const metadata = await openMetadata(session, record)
  assertActive()
  const bytes = await decryptPhoto(session, record, metadata, assertActive)
  try {
    return new Blob([bytes], { type: metadata.type })
  } finally {
    bytes.fill(0)
  }
}

function packetHeader(packet) {
  const bytes = new Uint8Array(16)
  bytes.set(packet.iv)
  new DataView(bytes.buffer).setUint32(12, packet.ciphertext.length ?? packet.ciphertext.size)
  return bytes
}

export async function createBackup(session, records) {
  const config = session.config
  if (!validConfig(config) || records.length > MAX_RECORDS || !records.every(validRecord)) {
    throw new VaultError('record')
  }
  const ids = records.map(record => record.id)
  if (new Set(ids).size !== ids.length) throw new VaultError('record')
  const photoBytes = records.reduce((total, record) => total + storedPhotoSize(record), 0)
  if (photoBytes > MAX_VAULT_BYTES) throw new VaultError('backup-size')
  const manifest = await seal(session, 'backup', '', encoder.encode(JSON.stringify(ids)))
  // The fixed header carries the vault parameters and the encrypted manifest's packet header.
  // Each following record is its ID and two packets with an IV, length, and ciphertext.
  const header = new Uint8Array(BACKUP_HEADER_BYTES)
  header.set(magic)
  header.set(config.salt, 8)
  header.set(idBytes(config.vaultId), 40)
  header.set(config.check.iv, 56)
  header.set(config.check.ciphertext, 68)
  header.set(packetHeader(manifest), 100)
  const parts = [header, manifest.ciphertext]
  for (const { id, metadata, photo } of records) {
    parts.push(idBytes(id), packetHeader(metadata), metadata.ciphertext, packetHeader(photo), photo.ciphertext)
  }
  const backup = new Blob(parts, { type: 'application/octet-stream' })
  if (backup.size > BACKUP_LIMIT) throw new VaultError('backup-size')
  return backup
}

function packetLength(header, offset = 0) {
  return new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(offset + IV_BYTES)
}

export async function restoreBackup(file, password, assertActive = () => {}) {
  if (!(file instanceof Blob) || file.size < BACKUP_HEADER_BYTES || file.size > BACKUP_LIMIT) {
    throw new VaultError('backup-size')
  }
  let offset = 0
  function take(length) {
    if (length > file.size - offset) throw new VaultError('backup-format')
    const piece = file.slice(offset, offset + length)
    offset += length
    return piece
  }
  async function read(length) {
    const bytes = new Uint8Array(await take(length).arrayBuffer())
    assertActive()
    return bytes
  }
  async function readPacket(limit) {
    const header = await read(16)
    const length = packetLength(header)
    if (length <= TAG_BYTES || length > limit) throw new VaultError('backup-format')
    return { iv: header.slice(0, IV_BYTES), ciphertext: take(length) }
  }

  const header = await read(BACKUP_HEADER_BYTES)
  if (!equalBytes(header.subarray(0, 8), magic)) throw new VaultError('backup-format')
  const manifestLength = packetLength(header, 100)
  if (manifestLength <= TAG_BYTES || manifestLength > MANIFEST_LIMIT) throw new VaultError('backup-format')
  const config = {
    version: VERSION,
    vaultId: toHex(header.subarray(40, 56)),
    salt: header.slice(8, 40),
    check: { iv: header.slice(56, 68), ciphertext: header.slice(68, 100) }
  }
  const session = await unlockVault(config, password)
  assertActive()
  const manifest = await open(session, 'backup', '', {
    iv: header.slice(100, 112),
    ciphertext: await read(manifestLength)
  })
  assertActive()
  const ids = JSON.parse(decoder.decode(manifest))
  if (!Array.isArray(ids) || ids.length > MAX_RECORDS || new Set(ids).size !== ids.length ||
      !ids.every(id => typeof id === 'string' && idPattern.test(id))) throw new VaultError('backup-format')

  const records = []
  let photoBytes = 0
  for (const id of ids) {
    if (toHex(await read(16)) !== id) throw new VaultError('backup-format')
    const packet = await readPacket(METADATA_LIMIT)
    const metadata = { iv: packet.iv, ciphertext: new Uint8Array(await packet.ciphertext.arrayBuffer()) }
    assertActive()
    const photo = await readPacket(MAX_PHOTO_BYTES + TAG_BYTES)
    photoBytes += photo.ciphertext.size - TAG_BYTES
    if (photoBytes > MAX_VAULT_BYTES) throw new VaultError('backup-size')
    const record = { id, metadata, photo }
    const decoded = await openMetadata(session, record)
    assertActive()
    const original = await decryptPhoto(session, record, decoded, assertActive)
    original.fill(0)
    records.push(record)
  }
  if (offset !== file.size) throw new VaultError('backup-format')
  assertActive()
  return { session, records }
}
