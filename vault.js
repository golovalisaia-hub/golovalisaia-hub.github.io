import {
  createVault, unlockVault, sealPhoto, openMetadata, openPhoto, createBackup, restoreBackup,
  generatePassword, isStrongPassword, MAX_RECORDS, VaultError
} from './vault-crypto.js'
import { openVaultStore } from './vault-store.js'

const byId = name => document.getElementById('vault-' + name)
const panels = {
  unavailable: byId('unavailable'),
  setup: byId('setup-panel'),
  unlock: byId('unlock-panel'),
  restore: byId('restore-panel'),
  library: byId('library')
}
const newPassword = byId('new-password')
const confirmPassword = byId('confirm-password')
const unlockPassword = byId('password')
const backupPassword = byId('backup-password')
const passwords = [newPassword, confirmPassword, unlockPassword, backupPassword]
const photoInput = byId('files')
const backupInput = byId('backup-file')
const backupLink = byId('save-backup')
const photoList = byId('photo-list')
const lockButton = byId('lock')
const message = byId('message')
const previewDialog = byId('preview')
const previewImage = byId('preview-image')
const previewStatus = byId('preview-status')
const previewSave = byId('preview-save')
const serviceWorkers = window.isSecureContext ? navigator.serviceWorker : null
const formatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 })
const dateFormatter = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' })
const idleLimit = 90_000
const pickerResultLimit = 45_000
const pickerHint = 'Введите пароль, чтобы добавить выбранные фотографии.'

let store
let config
let session
let operation
let photos = []
let pendingPicker
let entryMode = 'setup'
let idleTimer
let lastActivity = performance.now()
let initialization = 0
let preview

function shellReady() {
  return serviceWorkers?.controller?.scriptURL === new URL('/sw.js', location.href).href
}

function render() {
  const ready = Boolean(store && shellReady())
  const active = !ready ? 'unavailable' : session ? 'library' : config ? 'unlock' : entryMode
  for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== active
  for (const mode of ['setup', 'unlock', 'restore']) {
    byId(mode + '-fields').disabled = Boolean(operation) || active !== mode
  }
  byId('banner-actions').hidden = !ready || !config
  byId('state').dataset.open = String(Boolean(session))
  byId('state').lastChild.data = session ? 'Открыт' : 'Закрыт'
  lockButton.hidden = !session
  byId('import').disabled = Boolean(operation)
  byId('backup').disabled = Boolean(operation)
}

function announce(text = '', error = false) {
  message.textContent = text
  message.dataset.error = String(error)
  message.hidden = !text
}

function showPassword(show) {
  newPassword.type = show ? 'text' : 'password'
  const button = byId('show-password')
  button.setAttribute('aria-pressed', String(show))
  button.textContent = show ? 'Скрыть' : 'Показать'
}

function clearInputs() {
  for (const field of passwords) field.value = ''
  if (backupInput.value) backupInput.value = ''
  if (photoInput.value) photoInput.value = ''
  showPassword(false)
}

function clearBackup() {
  const url = backupLink.getAttribute('href')
  if (url) URL.revokeObjectURL(url)
  backupLink.removeAttribute('href')
  backupLink.hidden = true
  byId('backup').hidden = false
}

function resetPreview() {
  if (preview?.url) URL.revokeObjectURL(preview.url)
  preview = undefined
  previewImage.onload = null
  previewImage.onerror = null
  previewImage.removeAttribute('src')
  previewImage.hidden = true
  previewStatus.textContent = ''
  previewStatus.hidden = true
  byId('preview-name').textContent = ''
  byId('delete-confirm').hidden = true
  byId('preview-actions').hidden = false
  previewSave.disabled = true
  byId('confirm-delete').disabled = false
}

function closePreview() {
  resetPreview()
  if (previewDialog.open) previewDialog.close()
}

function clearPicker() {
  if (!pendingPicker) return
  clearTimeout(pendingPicker.timer)
  if (pendingPicker.files) pendingPicker.files.length = 0
  pendingPicker = undefined
}

function expirePicker(picker) {
  if (pendingPicker !== picker) return
  clearPicker()
  if (!document.hidden && message.textContent === pickerHint) {
    announce('Время для добавления истекло. Откройте фотосейф и выберите фотографии снова.')
  }
}

function resumePicker() {
  const picker = pendingPicker
  if (!picker?.files || document.hidden) return false
  picker.returnedWhileHidden = false
  if (Date.now() >= picker.deadline) {
    expirePicker(picker)
    return false
  }
  if (!store || !shellReady() || !config) {
    clearPicker()
    return false
  }
  if (operation) return false
  if (!session) {
    announce(pickerHint)
    trackActivity()
    unlockPassword.focus()
    return true
  }
  const files = picker.files
  picker.files = null
  clearPicker()
  void importFiles(files)
  return true
}

function lock(text = '', { focus = false, keepPicker = false } = {}) {
  const hadSession = Boolean(session || operation || pendingPicker?.files || passwords.some(field => field.value))
  operation?.controller.abort()
  operation = undefined
  session = undefined
  photos = []
  // A native picker can return associated File handles just before the page resumes.
  const waitingForPicker = pendingPicker && (!pendingPicker.files || pendingPicker.returnedWhileHidden)
  if (!keepPicker || !waitingForPicker) clearPicker()
  clearTimeout(idleTimer)
  clearInputs()
  clearBackup()
  closePreview()
  photoList.replaceChildren()
  byId('file-count').textContent = ''
  announce(hadSession ? text : '')
  render()
  if (focus && config && !panels.unlock.hidden) unlockPassword.focus()
}

function trackActivity() {
  clearTimeout(idleTimer)
  if (!session && !operation && !pendingPicker?.files && !passwords.some(field => field.value)) return
  lastActivity = performance.now()
  idleTimer = setTimeout(() => lock('Фотосейф закрыт из-за бездействия.'), idleLimit)
}

async function initialize() {
  const current = ++initialization
  const unavailable = byId('unavailable-text')
  const prepare = byId('prepare')
  prepare.hidden = true
  if (!window.isSecureContext || !window.crypto?.subtle || !window.indexedDB || !serviceWorkers) {
    unavailable.textContent = 'Этому браузеру недоступны локальное шифрование или хранилище.'
    render()
    return
  }
  if (!shellReady()) {
    unavailable.textContent = 'Откройте раздел «Карты», чтобы подготовить приложение к работе без интернета, затем вернитесь сюда.'
    prepare.hidden = false
    render()
    return
  }
  try {
    const localStore = store ?? await openVaultStore()
    const savedConfig = await localStore.readConfig()
    if (current !== initialization || !shellReady()) return
    store = localStore
    if (!session && !operation) config = savedConfig
  } catch {
    if (current !== initialization) return
    store = undefined
    unavailable.textContent = 'Не удалось открыть локальное хранилище. Закройте другие вкладки приложения и откройте фотосейф снова.'
  }
  render()
}

async function runOperation(text, fallback, work) {
  if (!store || !shellReady() || operation || document.hidden) return false
  const active = { controller: new AbortController() }
  operation = active
  const assertActive = () => {
    if (operation === active && performance.now() - lastActivity >= idleLimit) {
      lock('Фотосейф закрыт из-за бездействия.')
    }
    if (operation !== active || document.hidden || !shellReady()) {
      throw new DOMException('Photo vault operation expired', 'AbortError')
    }
  }
  announce(text)
  trackActivity()
  render()
  try {
    await work(assertActive, active.controller.signal)
    assertActive()
    return true
  } catch (error) {
    if (operation !== active || document.hidden) return false
    if (error.code === 'existing-vault') {
      announce('Фотосейф уже создан. Откройте его паролем.', true)
      operation = undefined
      await initialize()
    } else if (error.name === 'QuotaExceededError') {
      announce('В хранилище браузера не хватает места.', true)
    } else {
      announce(typeof fallback === 'function' ? fallback(error) : fallback, true)
    }
    return false
  } finally {
    if (operation === active) {
      operation = undefined
      render()
    }
  }
}

function fileSummary(metadata) {
  const size = metadata.size >= 1024 * 1024
    ? formatter.format(metadata.size / (1024 * 1024)) + ' МБ'
    : formatter.format(Math.max(0.1, metadata.size / 1024)) + ' КБ'
  const date = new Date(metadata.lastModified)
  if (!metadata.lastModified || !Number.isFinite(date.getTime())) return size
  return size + ' · ' + dateFormatter.format(date)
}

function renderGallery() {
  const list = document.createDocumentFragment()
  for (const entry of photos) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.className = 'photo-item'
    button.type = 'button'
    button.dataset.photo = entry.record.id
    const mark = document.createElement('span')
    mark.className = 'photo-item-mark'
    mark.setAttribute('aria-hidden', 'true')
    const icon = document.createElement('span')
    icon.className = 'icon icon-photo'
    mark.append(icon)
    const label = document.createElement('span')
    label.className = 'photo-item-label'
    const name = document.createElement('strong')
    name.dir = 'auto'
    name.textContent = entry.metadata.name
    const info = document.createElement('small')
    info.textContent = fileSummary(entry.metadata)
    label.append(name, info)
    const arrow = document.createElement('span')
    arrow.className = 'photo-item-arrow'
    arrow.textContent = '›'
    arrow.setAttribute('aria-hidden', 'true')
    button.append(mark, label, arrow)
    item.append(button)
    list.append(item)
  }
  photoList.replaceChildren(list)
  byId('file-count').textContent = photos.length ? formatter.format(photos.length) + ' фото' : ''
  byId('empty').hidden = photos.length > 0
}

async function loadGallery(next, records, assertActive) {
  const entries = []
  let unreadable = false
  for (const record of records) {
    assertActive()
    try {
      const metadata = await openMetadata(next, record)
      entries.push({ record, metadata })
    } catch {
      unreadable = true
    }
  }
  assertActive()
  entries.sort((a, b) => b.metadata.lastModified - a.metadata.lastModified)
  photos = entries
  renderGallery()
  return unreadable
}

function changeEntry(mode) {
  entryMode = mode
  clearInputs()
  announce()
  render()
  const heading = byId(mode + '-title')
  heading.tabIndex = -1
  heading.focus()
}

byId('show-restore').addEventListener('click', () => changeEntry('restore'))
byId('back-to-setup').addEventListener('click', () => changeEntry('setup'))
byId('show-password').addEventListener('click', () => showPassword(newPassword.type === 'password'))
byId('generate-password').addEventListener('click', () => {
  const password = generatePassword()
  newPassword.value = password
  confirmPassword.value = password
  showPassword(true)
  newPassword.focus()
  newPassword.select()
  trackActivity()
})

byId('setup-form').addEventListener('submit', async event => {
  event.preventDefault()
  const password = newPassword.value
  if (!isStrongPassword(password)) {
    announce('Введите длинный пароль из разных символов или сгенерируйте случайный.', true)
    newPassword.focus()
    return
  }
  if (password !== confirmPassword.value) {
    announce('Пароли различаются. Проверьте повторный ввод.', true)
    confirmPassword.focus()
    return
  }
  clearInputs()
  const created = await runOperation('Создаём фотосейф…', 'Не удалось создать фотосейф.', async (assertActive, signal) => {
    const next = await createVault(password)
    assertActive()
    await store.create(next.config, [], signal)
    assertActive()
    config = next.config
    session = next
    renderGallery()
    announce()
    trackActivity()
  })
  if (created && session) byId('import').focus()
})

byId('unlock-form').addEventListener('submit', async event => {
  event.preventDefault()
  const password = unlockPassword.value
  clearInputs()
  const unlocked = await runOperation('Проверяем пароль…', error =>
    error.code === 'password' ? 'Пароль не подошёл.' : 'Не удалось открыть фотосейф.', async assertActive => {
    const snapshot = await store.read()
    assertActive()
    const next = await unlockVault(snapshot.config, password)
    assertActive()
    const unreadable = await loadGallery(next, snapshot.records, assertActive)
    assertActive()
    config = next.config
    session = next
    announce(unreadable ? 'Часть записей повреждена. Они остались в фотосейфе.' : '', unreadable)
    trackActivity()
  })
  if (unlocked && session) {
    if (!resumePicker()) byId('import').focus()
  } else if (!operation && !document.hidden && !panels.unlock.hidden) {
    unlockPassword.focus()
  }
})

byId('restore-form').addEventListener('submit', event => {
  event.preventDefault()
  const file = backupInput.files[0]
  const password = backupPassword.value
  clearInputs()
  void runOperation('Проверяем и восстанавливаем копию…', error =>
    error.code === 'password'
      ? 'Проверьте пароль от резервной копии.'
      : 'Резервная копия повреждена, превышает лимит или имеет неизвестный формат.', async (assertActive, signal) => {
    const restored = await restoreBackup(file, password, assertActive)
    assertActive()
    await store.create(restored.session.config, restored.records, signal)
    assertActive()
    await loadGallery(restored.session, restored.records, assertActive)
    assertActive()
    config = restored.session.config
    session = restored.session
    announce('Фотосейф восстановлен из копии.')
    trackActivity()
  })
})

async function importFiles(files) {
  if (!session || !files.length) return
  const next = session
  clearBackup()
  try {
    await runOperation('Шифруем фотографии…', 'Не удалось добавить все фотографии.', async (assertActive, signal) => {
      signal.addEventListener('abort', () => { files.length = 0 }, { once: true })
      const total = files.length
      let added = 0
      let full = false
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]
        files[index] = null
        try {
          const record = await sealPhoto(next, file, assertActive)
          assertActive()
          await store.addPhoto(record, signal)
          assertActive()
          added += 1
        } catch (error) {
          assertActive()
          if (error.code === 'vault-full' || error.name === 'QuotaExceededError') {
            full = true
            break
          }
          if (!(error instanceof VaultError)) throw error
        }
        announce('Обработано ' + formatter.format(index + 1) + ' из ' + formatter.format(total) + '…')
      }
      const { records } = await store.read()
      assertActive()
      await loadGallery(next, records, assertActive)
      const summary = 'Добавлено ' + formatter.format(added) + ' из ' + formatter.format(total) + '.'
      let explanation = ''
      if (full) explanation = ' Достигнут лимит хранилища.'
      else if (added < total) explanation = ' Проверьте формат и размер пропущенных файлов.'
      announce(summary + explanation, added < total)
    })
  } finally {
    files.length = 0
  }
}

byId('import').addEventListener('click', () => {
  if (!session || operation || !shellReady() || document.hidden) return
  clearPicker()
  pendingPicker = { files: null, timer: undefined }
  photoInput.click()
})
photoInput.addEventListener('change', () => {
  const files = Array.from(photoInput.files).slice(0, MAX_RECORDS)
  photoInput.value = ''
  if (!files.length || !store || !shellReady()) {
    clearPicker()
    return
  }
  const picker = pendingPicker
  if (!picker) {
    if (!document.hidden && session) void importFiles(files)
    return
  }
  if (picker.files) return
  picker.files = files
  picker.deadline = Date.now() + pickerResultLimit
  picker.returnedWhileHidden = document.hidden
  picker.timer = setTimeout(() => expirePicker(picker), pickerResultLimit)
  if (document.hidden) {
    if (session || operation) lock('Фотосейф закрыт при переходе в фон.', { keepPicker: true })
  } else {
    resumePicker()
  }
})
photoInput.addEventListener('cancel', () => {
  if (!pendingPicker?.files) clearPicker()
})

byId('backup').addEventListener('click', () => {
  if (!session) return
  const next = session
  clearBackup()
  void runOperation('Готовим зашифрованную копию…', 'Не удалось подготовить резервную копию.', async assertActive => {
    const { records } = await store.read()
    assertActive()
    const backup = await createBackup(next, records)
    assertActive()
    backupLink.href = URL.createObjectURL(backup)
    backupLink.hidden = false
    byId('backup').hidden = true
    announce('Копия готова. Сохраните её в «Файлах».')
    backupLink.focus()
  })
})

function previewNotice(text) {
  previewStatus.textContent = text
  previewStatus.hidden = !text
}

async function openPreview(entry) {
  if (!session || operation || document.hidden) return
  const next = session
  const current = { id: entry.record.id, name: entry.metadata.name }
  closePreview()
  preview = current
  byId('preview-name').textContent = current.name
  previewNotice('Открываем фотографию…')
  previewDialog.showModal()
  const active = () => Boolean(preview === current && session === next && !document.hidden && shellReady())
  const assertActive = () => {
    if (!active()) throw new DOMException('Photo preview expired', 'AbortError')
  }
  try {
    const photo = await openPhoto(next, entry.record, assertActive)
    assertActive()
    current.type = photo.type
    current.url = URL.createObjectURL(photo)
    previewImage.onload = () => {
      if (!active()) return
      previewImage.hidden = false
      previewNotice('')
    }
    previewImage.onerror = () => {
      if (!active()) return
      previewNotice('Браузер не смог показать этот формат. Можно скачать оригинал.')
    }
    previewImage.src = current.url
    previewSave.disabled = false
  } catch {
    if (active()) previewNotice('Не удалось расшифровать фотографию.')
  }
}

photoList.addEventListener('click', event => {
  const button = event.target.closest('button[data-photo]')
  const entry = photos.find(item => item.record.id === button?.dataset.photo)
  if (entry) void openPreview(entry)
})

byId('preview-close').addEventListener('click', closePreview)
previewDialog.addEventListener('cancel', event => {
  event.preventDefault()
  closePreview()
})

previewSave.addEventListener('click', () => {
  if (!session || !preview?.url || document.hidden) return
  const extensions = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif', 'image/avif': 'avif'
  }
  const filename = preview.name.replace(/[\u0000-\u001f\u007f\\/:*?"<>|\p{Bidi_Control}]/gu, '_')
    .replace(/\.[^.]+$/, '').slice(0, 160).trim()
  const link = document.createElement('a')
  link.href = preview.url
  link.download = (filename || 'Фото') + '.' + extensions[preview.type]
  document.body.append(link)
  link.click()
  link.remove()
})

byId('preview-delete').addEventListener('click', () => {
  byId('preview-actions').hidden = true
  byId('delete-confirm').hidden = false
  byId('cancel-delete').focus()
})
byId('cancel-delete').addEventListener('click', () => {
  byId('delete-confirm').hidden = true
  byId('preview-actions').hidden = false
  byId('preview-delete').focus()
})
byId('confirm-delete').addEventListener('click', async () => {
  if (!session || !preview) return
  const { id } = preview
  closePreview()
  clearBackup()
  const deleted = await runOperation('Удаляем фотографию…', 'Не удалось удалить фотографию.', async (assertActive, signal) => {
    await store.deletePhoto(id, signal)
    assertActive()
    photos = photos.filter(entry => entry.record.id !== id)
    renderGallery()
    announce('Фотография удалена из сейфа.')
  })
  if (deleted && session) byId('import').focus()
})

lockButton.addEventListener('click', () => lock('Фотосейф закрыт.', { focus: true }))
for (const eventName of ['pointerdown', 'keydown', 'scroll', 'click', 'input']) {
  window.addEventListener(eventName, trackActivity, { capture: true, passive: true })
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    lock('Фотосейф закрыт при переходе в фон.', { keepPicker: true })
  } else {
    if (!config) void initialize()
    resumePicker()
  }
})
window.addEventListener('pagehide', () => lock())
window.addEventListener('pageshow', event => {
  if (event.persisted) void initialize()
})
serviceWorkers?.addEventListener('controllerchange', () => {
  lock('Приложение обновлено. Откройте фотосейф ещё раз.')
  void initialize()
})
void initialize()
