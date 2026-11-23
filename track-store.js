import {TRACK_FIX_GAP_MS, trackDistance, trackFixIssue} from './track-geometry.js';
import {fieldError, fieldTransaction, openFieldDatabase} from './field-db.js';
import {openFieldValue, sealFieldValue, verifyFieldKey} from './field-security.js';

const DATABASE = 'quiet-maps-track';
const TRACK = 'track';
const POINTS = 'points';
const ACTIVE = 'active';
const RECORDING_ACCURACY = 40;
const MAX_RECORDING_SPEED = 6;
const MAX_EDGE_METERS = 65;
const DECRYPT_BATCH = 128;

function snapshot({id, createdAt, distance}, points, revision) {
  const segments = [];
  for (const {point, breakBefore} of points) {
    if (breakBefore || !segments.length) segments.push([]);
    segments.at(-1).push(point);
  }
  return {id, createdAt, distance, segments, revision};
}

function checkPoint(point, track, breakBefore, now) {
  const reason = trackFixIssue(point, now, RECORDING_ACCURACY);
  if (reason) return {reason};
  const {lastPoint, lastObserved} = track;
  if (!lastPoint) return {breakBefore:true, distance:0};

  const elapsed = point.timestamp - lastObserved.timestamp;
  if (elapsed <= 0) return {reason:elapsed === 0 ? 'duplicate' : 'stale'};
  if (breakBefore || elapsed > TRACK_FIX_GAP_MS) return {breakBefore:true, distance:0};

  const uncertainty = Math.hypot(lastObserved.accuracy, point.accuracy);
  const plausibleDistance = Math.max(12, MAX_RECORDING_SPEED * elapsed / 1000 + uncertainty);
  if (trackDistance(lastObserved, point) > plausibleDistance) return {reason:'jump'};

  const distance = trackDistance(lastPoint, point);
  const spacing = Math.max(5, Math.min(18, Math.hypot(lastPoint.accuracy, point.accuracy) * 0.6));
  if (distance < spacing) return {reason:'duplicate', observed:true};
  if (distance > MAX_EDGE_METERS) return {breakBefore:true, distance:0};
  return {breakBefore:false, distance};
}

export async function openTrackStore(key) {
  const fieldId = await verifyFieldKey(key);
  const db = await openFieldDatabase(DATABASE, 2, (opened, version) => {
    // Version 1 was the unpublished, plaintext development schema.
    if (version === 1) {
      opened.deleteObjectStore(POINTS);
      opened.deleteObjectStore(TRACK);
    }
    opened.createObjectStore(TRACK);
    opened.createObjectStore(POINTS, {keyPath:'sequence'});
  });
  const transact = (mode, work) => fieldTransaction(db, [TRACK, POINTS], mode, work);
  const metadataBinding = ({id, revision}) => [fieldId, 'track-metadata', id, revision];
  const pointBinding = (id, sequence) => [fieldId, 'track-point', id, sequence];

  async function sealTrack(track) {
    const header = {id:track.id, revision:crypto.randomUUID()};
    return {...header, ...await sealFieldValue(key, metadataBinding(header), track)};
  }

  async function openTrack(record) {
    const track = await openFieldValue(key, metadataBinding(record), record);
    if (track?.id !== record.id || !Number.isSafeInteger(track.count) || track.count < 0) throw fieldError('field-corrupt');
    return track;
  }

  return {
    async load() {
      const stored = await transact('readonly', ([metadata, points], read, complete) => {
        read(metadata.get(ACTIVE), track => {
          if (!track) complete(null);
          else read(points.getAll(), records => complete({track, records}));
        });
      });
      if (!stored) return null;
      const track = await openTrack(stored.track);
      if (track.count !== stored.records.length) throw fieldError('field-corrupt');
      const points = [];
      for (let offset = 0; offset < stored.records.length; offset += DECRYPT_BATCH) {
        const batch = await Promise.all(stored.records.slice(offset, offset + DECRYPT_BATCH).map((record, index) => {
          if (record.sequence !== offset + index + 1) throw fieldError('field-corrupt');
          return openFieldValue(key, pointBinding(track.id, record.sequence), record);
        }));
        points.push(...batch);
      }
      return snapshot(track, points, stored.track.revision);
    },
    async create() {
      const track = {id:crypto.randomUUID(), createdAt:Date.now(), distance:0, count:0,
        lastPoint:null, lastObserved:null};
      const encrypted = await sealTrack(track);
      return transact('readwrite', ([metadata], read, complete) => {
        read(metadata.get(ACTIVE), existing => {
          if (existing) throw fieldError('existing-track');
          metadata.add(encrypted, ACTIVE);
          complete(snapshot(track, [], encrypted.revision));
        });
      });
    },
    async append(trackId, fix, {breakBefore = false} = {}) {
      const point = {lng:fix?.lng, lat:fix?.lat, accuracy:fix?.accuracy, timestamp:fix?.timestamp};
      if (Number.isFinite(fix?.altitude)) point.altitude = fix.altitude;
      if (Number.isFinite(fix?.speed) && fix.speed >= 0) point.speed = fix.speed;
      // Web Crypto completes outside IndexedDB transactions. Compare revisions before committing.
      for (;;) {
        const stored = await transact('readonly', ([metadata], read, complete) => read(metadata.get(ACTIVE), complete));
        if (!stored || stored.id !== trackId) throw fieldError('missing-track');
        const track = await openTrack(stored);
        const acceptance = checkPoint(point, track, breakBefore, Date.now());
        if (acceptance.reason && !acceptance.observed) return {point:null, reason:acceptance.reason};

        track.lastObserved = point;
        let encryptedPoint;
        if (!acceptance.reason) {
          track.count++;
          track.distance += acceptance.distance;
          track.lastPoint = point;
          const sequence = track.count;
          const payload = await sealFieldValue(key, pointBinding(trackId, sequence), {point, breakBefore:acceptance.breakBefore});
          encryptedPoint = {sequence, ...payload};
        }
        const encryptedTrack = await sealTrack(track);
        const committed = await transact('readwrite', ([metadata, points], read, complete) => {
          read(metadata.get(ACTIVE), current => {
            if (!current || current.id !== trackId) throw fieldError('missing-track');
            if (current.revision !== stored.revision) {
              complete(false);
              return;
            }
            if (encryptedPoint) points.add(encryptedPoint);
            metadata.put(encryptedTrack, ACTIVE);
            complete(true);
          });
        });
        if (committed) {
          return acceptance.reason ? {point:null, reason:acceptance.reason} :
            {point, breakBefore:acceptance.breakBefore, distance:track.distance};
        }
      }
    },
    close() { db.close(); },
    delete(trackId,revision) {
      return transact('readwrite', ([metadata, points], read, complete) => {
        read(metadata.get(ACTIVE), track => {
          if (!track || track.id !== trackId || revision && revision !== track.revision) {
            complete(false);
            return;
          }
          points.clear();
          metadata.delete(ACTIVE);
          complete(true);
        });
      });
    },
  };
}
