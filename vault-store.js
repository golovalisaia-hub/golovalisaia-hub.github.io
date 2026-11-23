import { MAX_VAULT_BYTES, MAX_RECORDS, TAG_BYTES, VaultError } from './vault-crypto.js'

const DATABASE = 'quiet-maps-vault'
const SETTINGS = 'vault'
const PHOTOS = 'photos'
const CONFIG = 'configuration'

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    let blocked = false
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore(SETTINGS)
      db.createObjectStore(PHOTOS, { keyPath: 'id' })
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => {
      blocked = true
      reject(new VaultError('storage-blocked'))
    }
    request.onsuccess = () => {
      const db = request.result
      if (blocked) {
        db.close()
        return
      }
      db.onversionchange = () => db.close()
      resolve(db)
    }
  })
}

function transaction(db, mode, signal, work) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const tx = db.transaction([SETTINGS, PHOTOS], mode)
    let result
    let failure
    const complete = value => { result = value }
    const fail = error => {
      failure = error
      try {
        tx.abort()
      } catch (abortError) {
        if (abortError.name !== 'InvalidStateError') throw abortError
      }
    }
    const cancel = () => fail(signal.reason)
    const cleanup = () => signal?.removeEventListener('abort', cancel)
    tx.oncomplete = () => {
      cleanup()
      resolve(result)
    }
    tx.onabort = () => {
      cleanup()
      reject(failure ?? tx.error ?? new VaultError('storage'))
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      work(tx.objectStore(SETTINGS), tx.objectStore(PHOTOS), complete, fail)
    } catch (error) {
      fail(error)
    }
  })
}

export async function openVaultStore() {
  const db = await openDatabase()
  return {
    readConfig() {
      return transaction(db, 'readonly', null, (settings, _photos, complete) => {
        const request = settings.get(CONFIG)
        request.onsuccess = () => complete(request.result)
      })
    },
    read() {
      return transaction(db, 'readonly', null, (settings, photos, complete) => {
        const configuration = settings.get(CONFIG)
        const records = photos.getAll()
        records.onsuccess = () => complete({ config: configuration.result, records: records.result })
      })
    },
    create(config, records, signal) {
      return transaction(db, 'readwrite', signal, (settings, photos, _complete, fail) => {
        const request = settings.add(config, CONFIG)
        request.onerror = event => {
          if (request.error.name !== 'ConstraintError') return
          event.preventDefault()
          fail(new VaultError('existing-vault'))
        }
        for (const record of records) photos.add(record)
      })
    },
    addPhoto(record, signal) {
      return transaction(db, 'readwrite', signal, (_settings, photos, _complete, fail) => {
        const request = photos.getAll()
        request.onsuccess = () => {
          const available = request.result
          let size = 0
          for (const photo of available) {
            const encrypted = photo.photo?.ciphertext
            if (!(encrypted instanceof Blob) || encrypted.size <= TAG_BYTES) {
              fail(new VaultError('record'))
              return
            }
            size += encrypted.size - TAG_BYTES
          }
          if (available.length >= MAX_RECORDS || size + record.photo.ciphertext.size - TAG_BYTES > MAX_VAULT_BYTES) {
            fail(new VaultError('vault-full'))
            return
          }
          photos.add(record)
        }
      })
    },
    deletePhoto(id, signal) {
      return transaction(db, 'readwrite', signal, (_settings, photos) => {
        photos.delete(id)
      })
    }
  }
}
