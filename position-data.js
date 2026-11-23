// @ts-check
import {TRACK_FIX_MAX_AGE_MS, trackDistance} from './track-geometry.js';

/** @typedef {{lat:number,lng:number,accuracy:number,timestamp:number,heading:number|null,altitude:number|null,speed:number|null}} Fix */
/** @typedef {{lat:number,lng:number,accuracy?:number}} Position */
/** @typedef {number[][]} Ring */
/** @typedef {{type:'Polygon',coordinates:Ring[]} | {type:'MultiPolygon',coordinates:Ring[][]}} Boundary */

/** @param {GeolocationPosition} reading @param {number} now @returns {Fix|null} */
export function readGpsFix({coords,timestamp}, now = Date.now()) {
  if (!coords || !Number.isFinite(timestamp) || timestamp <= 0 ||
      now - timestamp >= TRACK_FIX_MAX_AGE_MS || timestamp - now > 2000) return null;
  const {latitude:lat,longitude:lng,accuracy,altitude,speed,heading} = coords;
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180 ||
      !Number.isFinite(accuracy) || accuracy < 0) return null;
  return {
    lat,lng,accuracy,timestamp,
    heading:Number.isFinite(heading) && heading !== null && heading >= 0 && heading < 360 && speed !== 0 ? heading : null,
    altitude:Number.isFinite(altitude) ? altitude : null,
    speed:Number.isFinite(speed) && speed !== null && speed >= 0 ? speed : null,
  };
}

/** @param {Position} from @param {Position} to */
export function getBearing(from,to) {
  const distance = trackDistance(from,to);
  if (distance <= Math.max(1,(from.accuracy ?? 0) + (to.accuracy ?? 0))) {
    return {distance,degrees:null};
  }
  const radians = Math.PI / 180;
  const start = from.lat * radians;
  const end = to.lat * radians;
  const delta = (to.lng - from.lng) * radians;
  const east = Math.sin(delta) * Math.cos(end);
  const north = Math.cos(start) * Math.sin(end) - Math.sin(start) * Math.cos(end) * Math.cos(delta);
  return {distance,degrees:(Math.atan2(east,north) / radians + 360) % 360};
}

/** @param {Ring} ring @param {number} lng @param {number} lat */
function ringStatus(ring,lng,lat) {
  let inside = false;
  for (let index = 1; index < ring.length; index++) {
    const [ax,ay] = ring[index-1];
    const [bx,by] = ring[index];
    if (lng >= Math.min(ax,bx) && lng <= Math.max(ax,bx) && lat >= Math.min(ay,by) && lat <= Math.max(ay,by) &&
        Math.abs((lng-ax)*(by-ay) - (lat-ay)*(bx-ax)) <= 1e-12) return 'edge';
    if ((ay > lat) !== (by > lat) && lng < ax + (bx-ax)*(lat-ay)/(by-ay)) inside = !inside;
  }
  return inside ? 'inside' : 'outside';
}

/** @param {Boundary | undefined} boundary @param {number} lng @param {number} lat */
export function inAdministrativeRegion(boundary,lng,lat) {
  if (!boundary || !Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  const polygons = boundary.type === 'Polygon' ? [boundary.coordinates] : boundary.coordinates;
  return polygons.some(([outer,...holes]) => {
    const status = ringStatus(outer,lng,lat);
    return status === 'edge' || (status === 'inside' && !holes.some(hole => ringStatus(hole,lng,lat) === 'inside'));
  });
}

/** @param {Pick<Fix,'lat'|'lng'|'accuracy'|'timestamp'>} fix */
export function locationText(fix) {
  return 'WGS 84 ' + fix.lat.toFixed(6) + ', ' + fix.lng.toFixed(6) +
    ' · точность ±' + Math.ceil(fix.accuracy) + ' м · ' + new Date(fix.timestamp).toISOString();
}
