export function createNavigationClient(archive,profile = 'car') {
  const worker = new Worker(new URL('./navigation-worker.js', import.meta.url), {type:'module'});
  const pending = new Map();
  let sequence = 0;
  let dead = false;

  function dispose(error = new Error('Навигация остановлена.')) {
    if (dead) return;
    dead = true;
    worker.terminate();
    for (const {reject} of pending.values()) reject(error);
    pending.clear();
  }

  function request(type,payload) {
    return new Promise((resolve,reject) => {
      if (dead) {
        reject(new Error('Навигация остановлена.'));
        return;
      }
      const id = ++sequence;
      pending.set(id,{resolve,reject});
      try { worker.postMessage({id,type,payload}); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }

  worker.addEventListener('message', ({data:{id,result,error}}) => {
    const handlers = pending.get(id);
    if (!handlers) return;
    pending.delete(id);
    if (error) handlers.reject(Object.assign(new Error(error.message),{code:error.code}));
    else handlers.resolve(result);
  });
  worker.addEventListener('error', () => dispose(new Error('Не удалось открыть офлайн-навигацию.')));

  const ready = request('initialize',{archive,profile});
  return {
    async search(query) { await ready; return request('search',query); },
    async route(start,goal) { await ready; return request('route',{start,goal}); },
    dispose,
  };
}
