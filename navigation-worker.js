import {createAddressSearch} from './address-search.js';
import {createRouter} from './routing-engine.js';

let lookup;
let router;
let graph;

async function readBundle({archive,profile}) {
  const data = await new Response(archive.stream().pipeThrough(new DecompressionStream('gzip'))).json();
  if (data.schema !== 1 || (data.profile ?? 'car') !== profile) throw new Error('Неподходящий пакет навигации.');
  const {addresses,...routingData} = data;
  lookup = profile === 'car' ? createAddressSearch(addresses) : undefined;
  router = undefined;
  graph = routingData;
}

self.addEventListener('message', async ({data:{id,type,payload}}) => {
  try {
    let result;
    if (type === 'initialize') {
      await readBundle(payload);
    } else if (type === 'search' && lookup) {
      result = lookup.search(payload, 16);
    } else if (type === 'route' && (router || graph)) {
      router ??= createRouter(graph);
      graph = undefined;
      result = router.route(payload.start, payload.goal);
    } else {
      throw new Error('Навигация ещё не готова.');
    }
    self.postMessage({id,result});
  } catch (error) {
    self.postMessage({id,error:{message:error.message,code:error.code}});
  }
});
