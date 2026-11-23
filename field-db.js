export function fieldError(code, details) {
  return Object.assign(new Error(code), {code}, details);
}

export function openFieldDatabase(name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    let blocked = false;
    request.onupgradeneeded = event => upgrade(request.result, event.oldVersion);
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(fieldError('storage-blocked'));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

export function fieldTransaction(db, stores, mode, work) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    let result;
    let failure;
    const complete = value => { result = value; };
    const abort = error => {
      failure = error;
      transaction.abort();
    };
    // IndexedDB accepts dependent requests inside a success callback, before it commits.
    const read = (request, receive) => {
      request.onsuccess = () => {
        try { receive(request.result); }
        catch (error) { abort(error); }
      };
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure ?? transaction.error ?? fieldError('storage'));
    try {
      work(stores.map(store => transaction.objectStore(store)), read, complete);
    } catch (error) {
      abort(error);
    }
  });
}
