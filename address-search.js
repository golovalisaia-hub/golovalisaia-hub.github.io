const MAX_QUERY_LENGTH = 160;
const STREET_ORDINAL = /^\d+-(?:й|я|е|го|ой|ая|ое|ый|ий|ю|му|х)$/u;
const ANNIVERSARY = /^(?:лет|год|года|годовщина|годовщины|летия)$/u;
const localityAbbreviations = {г: 'город', п: 'поселок', с: 'село', д: 'деревня'};

const addressLabels = new Set([
  'г', 'город', 'п', 'пос', 'поселок', 'пгт', 'с', 'село', 'дер', 'деревня',
  'д', 'дом', 'домовладение',
]);
const streetTypes = new Map(Object.entries({
  ул: 'улица', улица: 'улица', улицы: 'улица',
  'пр-т': 'проспект', 'пр-кт': 'проспект', просп: 'проспект', проспект: 'проспект',
  пер: 'переулок', переулок: 'переулок',
  ш: 'шоссе', шоссе: 'шоссе',
  наб: 'набережная', набережная: 'набережная',
  пл: 'площадь', площадь: 'площадь',
  'б-р': 'бульвар', бул: 'бульвар', бульвар: 'бульвар',
  'пр-д': 'проезд', проезд: 'проезд',
  мкр: 'микрорайон', микрорайон: 'микрорайон',
  туп: 'тупик', тупик: 'тупик',
  алл: 'аллея', аллея: 'аллея',
}));
const designators = new Set(streetTypes.values());

function fold(text) {
  return text.replaceAll('№', ' ').normalize('NFKC').toLowerCase().replaceAll('ё', 'е')
    .replace(/[\u2010-\u2015\u2212]/g, '-');
}

function addressSyntax(text) {
  return fold(text)
    .replace(/(^|[^\p{L}\d])([гпсд])\.(?!\s*\d)/gu, (_, prefix, kind) => prefix + localityAbbreviations[kind] + ' ')
    .replace(/[^\p{L}\d\s/\\-]+/gu, ' ')
    .trim()
    .replace(/(\d[a-zа-я]?)\s*-?\s*(?:корпус|корп|кор|к|k)\s*(?=\d)/gu, '$1к')
    .replace(/(\d[a-zа-я]?)\s*-?\s*(?:строение|стр|с|c)\s*(?=\d)/gu, '$1с')
    .replace(/(\d[a-zа-я]?)\s*([/\\])\s*/gu, '$1$2')
    .replace(/(\d[a-zа-я]?)\s*-\s*(?=\d|$)/gu, '$1-')
    .replace(/(\d[a-zа-я]?)\s+(?:литера|лит)\s*([a-zа-я])(?=\s|$)/gu, '$1$2')
    .replace(/(\d+)\s+([a-zа-я])(?=\s|$)/gu, '$1$2')
    .replace(/\s+/gu, ' ');
}

function queryWords(value) {
  if (typeof value !== 'string' || value.length > MAX_QUERY_LENGTH) return [];
  return addressSyntax(value).split(' ');
}

function containsHouseNumber(words) {
  return words.some((word, index) => /^(?:[a-zа-я]{1,3}-?)?\d/u.test(word) &&
    !STREET_ORDINAL.test(word) && !ANNIVERSARY.test(words[index + 1] || ''));
}

export function hasHouseNumber(query) {
  return containsHouseNumber(queryWords(query));
}

function nameWords(text) {
  return fold(text).replace(/[^\p{L}\d\s-]+/gu, ' ').split(/\s+/u)
    .flatMap(word => streetTypes.get(word) || word.split('-'))
    .filter(word => word && !addressLabels.has(word));
}

function nameParts(words) {
  // Набережная улица is a street named Набережная.
  let index = -1;
  if (words.length > 1) {
    index = words.indexOf('улица');
    if (index < 0) index = words.findIndex(word => designators.has(word));
  }
  return {
    type: words[index] || '',
    words: words.filter((_, position) => position !== index),
  };
}

function nameScore(query, actual, exactOnly) {
  if (!query.words.length) return query.type ? -1 : 0;
  if (query.type && actual.type && query.type !== actual.type) return -1;
  let start = 0;
  let exact = 0;
  for (const term of query.words) {
    while (start < actual.words.length && !actual.words[start].startsWith(term)) start++;
    if (start === actual.words.length) return -1;
    if (actual.words[start] === term) exact++;
    start++;
  }
  const complete = exact === actual.words.length;
  if (exactOnly && !complete) return -1;
  return exact + (complete ? MAX_QUERY_LENGTH : 0) +
    Number(Boolean(query.type && query.type === actual.type));
}

function searchPatterns(words) {
  const patterns = [];
  for (let split = 0; split < words.length; split++) {
    const first = nameParts(words.slice(0, split));
    const second = nameParts(words.slice(split));
    patterns.push([first, second], [second, first]);
  }
  return patterns;
}

function addressScore(patterns, entry, exactOnly) {
  let best = -1;
  for (const [street, locality] of patterns) {
    if (Boolean(street.words.length) !== Boolean(entry.street.words.length)) continue;
    if (locality.type && locality.type !== entry.locality.type) continue;
    const streetScore = nameScore(street, entry.street, exactOnly);
    if (streetScore < 0) continue;
    const localityScore = nameScore(locality, entry.locality, exactOnly);
    if (localityScore >= 0) best = Math.max(best, streetScore + localityScore);
  }
  return best;
}

function namePairKey(street, locality) {
  return street.words.join(' ') + '\0' + locality.words.join(' ');
}

export function createAddressSearch(rows) {
  const byHouse = new Map();
  const seen = new Set();
  const names = new Map();
  const knownNamePairs = new Map();
  const emptyName = {type: '', words: []};
  let longestHouse = 0;

  function fields(name) {
    if (!names.has(name)) names.set(name, nameParts(nameWords(name)));
    return names.get(name);
  }

  function recordNamePair(street, locality) {
    const key = namePairKey(street, locality);
    if (!knownNamePairs.has(key)) knownNamePairs.set(key, new Set());
    knownNamePairs.get(key).add(street.type + '\0' + locality.type);
  }

  function isKnownNamePair([street, locality]) {
    const types = knownNamePairs.get(namePairKey(street, locality));
    if (!types) return false;
    for (const pair of types) {
      const [streetType, localityType] = pair.split('\0');
      if ((!street.type || !streetType || street.type === streetType) &&
        (!locality.type || locality.type === localityType)) return true;
    }
    return false;
  }

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row)) continue;
    const [locality, street, house, lon, lat] = row;
    if (typeof locality !== 'string' || typeof street !== 'string' || typeof house !== 'string') continue;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180 || !Number.isFinite(lat) || Math.abs(lat) > 90) continue;
    const houseKey = addressSyntax(house).replace(/^(?:д|дом)\s+/u, '');
    if (houseKey.length > MAX_QUERY_LENGTH || !/\d/u.test(houseKey)) continue;
    const entry = {locality: fields(locality), street: fields(street), row: [locality, street, house, lon, lat]};
    if (!entry.locality.words.length && !entry.street.words.length) continue;
    const key = JSON.stringify([entry.locality, entry.street, houseKey]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byHouse.has(houseKey)) byHouse.set(houseKey, []);
    byHouse.get(houseKey).push(entry);
    recordNamePair(entry.street, entry.locality);
    if (entry.street.words.length) recordNamePair(entry.street, emptyName);
    longestHouse = Math.max(longestHouse, houseKey.split(' ').length);
  }

  function search(query, limit = 12) {
    if (!Number.isFinite(limit) || Math.floor(limit) < 1) return [];
    const words = queryWords(query);
    if (!containsHouseNumber(words)) return [];
    const matches = new Map();

    for (let start = 0; start < words.length; start++) {
      const last = Math.min(words.length, start + longestHouse);
      for (let end = start + 1; end <= last; end++) {
        const entries = byHouse.get(words.slice(start, end).join(' '));
        if (!entries) continue;
        const name = [...words.slice(0, start), ...words.slice(end)].join(' ');
        const patterns = searchPatterns(nameWords(name));
        // Complete names already in the directory identify the intended address.
        const exactPatterns = patterns.filter(isKnownNamePair);
        for (const entry of entries) {
          const score = exactPatterns.length ? addressScore(exactPatterns, entry, true) :
            addressScore(patterns, entry, false);
          if (score > (matches.get(entry) ?? -1)) matches.set(entry, score);
        }
      }
    }
    return [...matches].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([{row}]) => {
      const [locality, street, house, lon, lat] = row;
      return {name: `${street || locality}, ${house}`, detail: locality, center: [lon, lat],
        kind: 'address', street, house, locality};
    });
  }

  return {search};
}
