import { MAX_VAULT_BYTES, MAX_RECORDS, storedPhotoSize, VaultError } from './vault-crypto.js'

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

function addStoredPhoto(photos, record, fail) {
  const request = photos.add(record)
  request.onerror = event => {
    if (request.error.name === 'AbortError') return
    event.preventDefault()
    fail(request.error)
  }
  return request
}

export async function openVaultStore() {
  const db = await openDatabase()
  let storeBlobs = true

  async function writePhotos(records, signal, write) {
    if (storeBlobs) {
      try {
        return await write(records)
      } catch (error) {
        if (signal?.aborted || !records.some(record => record.photo.ciphertext instanceof Blob) ||
            !(error.name === 'DataCloneError' || error.name === 'UnknownError' && /Blob\/File/i.test(error.message))) {
          throw error
        }
        // WebKit can reject Blob values in IndexedDB. The failed transaction is already aborted.
        storeBlobs = false
      }
    }
    const compatible = []
    for (const record of records) {
      signal?.throwIfAborted()
      const { photo } = record
      const ciphertext = photo.ciphertext instanceof Blob ? new Uint8Array(await photo.ciphertext.arrayBuffer()) : photo.ciphertext
      compatible.push({ ...record, photo: { ...photo, ciphertext } })
    }
    return write(compatible)
  }

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
      return writePhotos(records, signal, items => transaction(db, 'readwrite', signal, (settings, photos, _complete, fail) => {
        const request = settings.add(config, CONFIG)
        request.onerror = event => {
          if (request.error.name !== 'ConstraintError') return
          event.preventDefault()
          fail(new VaultError('existing-vault'))
        }
        let index = 0
        function addNext() {
          if (index === items.length) return
          try {
            addStoredPhoto(photos, items[index++], fail).onsuccess = addNext
          } catch (error) {
            fail(error)
          }
        }
        request.onsuccess = addNext
      }))
    },
    addPhoto(record, signal) {
      return writePhotos([record], signal, ([item]) => transaction(db, 'readwrite', signal, (_settings, photos, _complete, fail) => {
        const request = photos.getAll()
        request.onsuccess = () => {
          const available = request.result
          let size = 0
          for (const photo of available) {
            const bytes = storedPhotoSize(photo)
            if (!bytes) {
              fail(new VaultError('record'))
              return
            }
            size += bytes
          }
          if (available.length >= MAX_RECORDS || size + storedPhotoSize(item) > MAX_VAULT_BYTES) {
            fail(new VaultError('vault-full'))
            return
          }
          try {
            addStoredPhoto(photos, item, fail)
          } catch (error) {
            fail(error)
          }
        }
      }))
    },
    deletePhoto(id, signal) {
      return transaction(db, 'readwrite', signal, (_settings, photos) => {
        photos.delete(id)
      })
    }
  }
}
