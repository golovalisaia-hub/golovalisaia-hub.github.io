const EARTH_RADIUS = 6371008.8;
const RADIANS = Math.PI / 180;
const METERS_PER_DEGREE = EARTH_RADIUS * RADIANS;
const MIN_RETURN_DISTANCE = 25;
const MAX_GUIDANCE_ACCURACY = 25;
const MATCH_RADIUS = 24;
const MATCH_BUDGET = 42;
const BRANCH_SEPARATION = 30;
const MAX_BRANCH_MARGIN = 24;

export const TRACK_FIX_MAX_AGE_MS = 12000;
export const TRACK_FIX_GAP_MS = 30000;

export function trackFixIssue(fix, now, maxAccuracy) {
  if (!fix || !Number.isFinite(fix.lng) || Math.abs(fix.lng) > 180 ||
      !Number.isFinite(fix.lat) || Math.abs(fix.lat) > 90 ||
      !Number.isFinite(fix.accuracy) || fix.accuracy < 0 ||
      !Number.isFinite(fix.timestamp) || fix.timestamp <= 0) return 'invalid';
  if (now - fix.timestamp > TRACK_FIX_MAX_AGE_MS || fix.timestamp - now > 2000) return 'stale';
  if (fix.accuracy > maxAccuracy) return 'accuracy';
  return null;
}

function longitudeDelta(from, to) {
  const difference = to - from;
  if (difference > 180) return difference - 360;
  if (difference < -180) return difference + 360;
  return difference;
}

export function trackDistance(from, to) {
  const latitude = Math.sin((to.lat - from.lat) * RADIANS / 2);
  const longitude = Math.sin(longitudeDelta(from.lng, to.lng) * RADIANS / 2);
  const a = latitude ** 2 + Math.cos(from.lat * RADIANS) * Math.cos(to.lat * RADIANS) * longitude ** 2;
  return 2 * EARTH_RADIUS * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function trackSection(points) {
  const coordinates = [];
  const accuracies = [];
  const cumulativeDistances = [];
  let distance = 0;
  let previous = null;
  for (const point of points) {
    if (previous) distance += trackDistance(previous, point);
    coordinates.push([point.lng, point.lat]);
    accuracies.push(point.accuracy);
    cumulativeDistances.push(distance);
    previous = point;
  }
  return {coordinates, accuracies, cumulativeDistances, distance};
}

function project(fix, from, to, longitudeScale) {
  const lngDelta = longitudeDelta(from[0], to[0]);
  const latDelta = to[1] - from[1];
  const dx = lngDelta * longitudeScale;
  const dy = latDelta * METERS_PER_DEGREE;
  const x = longitudeDelta(from[0], fix.lng) * longitudeScale;
  const y = (fix.lat - from[1]) * METERS_PER_DEGREE;
  const lengthSquared = dx * dx + dy * dy;
  const fraction = lengthSquared ? Math.max(0, Math.min(1, (x * dx + y * dy) / lengthSquared)) : 0;
  const distance = Math.hypot(x - fraction * dx, y - fraction * dy);
  if (fraction === 0) return {fraction, distance, coordinate:from};
  if (fraction === 1) return {fraction, distance, coordinate:to};
  const lng = from[0] + fraction * lngDelta;
  const wrappedLng = lng > 180 ? lng - 360 : lng < -180 ? lng + 360 : lng;
  return {fraction, distance, coordinate:[wrappedLng, from[1] + fraction * latDelta]};
}

function collectMatches(section, fix, sectionIndex, matches, firstEdge = 0) {
  const {coordinates, accuracies, cumulativeDistances} = section;
  const longitudeScale = METERS_PER_DEGREE * Math.cos(fix.lat * RADIANS);
  const edgeCount = coordinates.length === 1 ? 1 : coordinates.length - 1;
  for (let index = firstEdge; index < edgeCount; index++) {
    const next = Math.min(index + 1, coordinates.length - 1);
    const projection = project(fix, coordinates[index], coordinates[next], longitudeScale);
    if (projection.distance > MATCH_RADIUS + MAX_BRANCH_MARGIN) continue;
    const accuracy = Math.max(accuracies[index], accuracies[next]);
    const from = cumulativeDistances[index];
    const along = from + projection.fraction * (cumulativeDistances[next] - from);
    matches.push({...projection, sectionIndex, index, accuracy, along});
  }
}

function bestMatch(matches, fix, allowed = () => true) {
  let best = null;
  for (const match of matches) {
    const radius = Math.min(MATCH_RADIUS, MATCH_BUDGET - Math.hypot(fix.accuracy, match.accuracy));
    if (!allowed(match) || match.distance > radius) continue;
    if (!best || match.distance < best.distance) best = match;
  }
  return best;
}

function differentBranch(match, best) {
  return match.sectionIndex !== best.sectionIndex || Math.abs(match.along - best.along) > BRANCH_SEPARATION;
}

function branchMargin(match, best, fix) {
  const uncertainty = Math.hypot(fix.accuracy, match.accuracy, best.accuracy);
  return Math.max(6, Math.min(MAX_BRANCH_MARGIN, uncertainty * 0.8));
}

function competingSectionStatus(route, fix, best) {
  const {sections, sectionIndex, edgeIndex} = route.matchContext;
  const alternatives = [];
  // Inspect the suffix of the selected section and every separate recorded section.
  sections.forEach((section, index) => {
    collectMatches(section, fix, index, alternatives, index === sectionIndex ? edgeIndex : 0);
  });
  const selectedPosition = {sectionIndex, along:route.distance - best.along};
  let status = null;
  for (const match of alternatives) {
    if (match.sectionIndex === sectionIndex && match.along <= route.distance) continue;
    if (!differentBranch(match, selectedPosition)) continue;
    const margin = branchMargin(match, best, fix);
    if (match.distance + margin < best.distance) return 'off-track';
    if (match.distance <= best.distance + margin) status = 'ambiguous';
  }
  return status;
}

export function makeBacktrack(segments, fix, now = Date.now()) {
  if (trackFixIssue(fix, now, MAX_GUIDANCE_ACCURACY)) return {status:'weak-fix'};
  const sections = segments.map(trackSection);
  if (!sections.some(section => section.distance >= MIN_RETURN_DISTANCE)) return {status:'too-short'};

  const matches = [];
  sections.forEach((section, index) => collectMatches(section, fix, index, matches));
  const best = bestMatch(matches, fix);
  if (!best) return {status:'off-track'};
  if (matches.some(match => differentBranch(match, best) &&
      match.distance <= best.distance + branchMargin(match, best, fix))) return {status:'ambiguous'};
  if (best.along < MIN_RETURN_DISTANCE) return {status:'too-short'};

  const section = sections[best.sectionIndex];
  const coordinates = [best.coordinate];
  const accuracies = [best.accuracy];
  const cumulativeDistances = [0];
  for (let index = best.index; index >= 0; index--) {
    const distance = best.along - section.cumulativeDistances[index];
    if (distance <= cumulativeDistances.at(-1)) continue;
    coordinates.push(section.coordinates[index]);
    accuracies.push(section.accuracies[index]);
    cumulativeDistances.push(distance);
  }
  return {status:'ready', route:{coordinates, accuracies, cumulativeDistances,
    distance:best.along, startedAt:fix.timestamp, partial:best.sectionIndex > 0,
    matchContext:{sections, sectionIndex:best.sectionIndex, edgeIndex:best.index}}};
}

export function backtrackProgress(route, fix, previous = null, now = Date.now()) {
  const distanceFromStart = previous?.distanceFromStart ?? 0;
  const lastTimestamp = previous?.timestamp ?? route.startedAt;
  const stationary = status => ({status, distanceFromStart, remainingDistance:route.distance - distanceFromStart,
    coordinateIndex:previous?.coordinateIndex ?? 0, timestamp:lastTimestamp});
  if (trackFixIssue(fix, now, MAX_GUIDANCE_ACCURACY) || fix.timestamp < lastTimestamp) return stationary('weak-fix');

  // Keep a match local to the previous fix so a crossing cannot skip a loop in the trip.
  const elapsed = fix.timestamp - lastTimestamp;
  const reach = Math.max(20, Math.min(60, 10 + elapsed / 1000 * 4));
  const nearby = match => Math.abs(match.along - distanceFromStart) <= reach;
  const matches = [];
  collectMatches(route, fix, 0, matches);
  const best = bestMatch(matches, fix, nearby);
  if (!best) return stationary('off-track');
  for (const match of matches) {
    if (!differentBranch(match, best)) continue;
    const margin = branchMargin(match, best, fix);
    const withinReach = nearby(match);
    if ((withinReach || elapsed > TRACK_FIX_GAP_MS) && match.distance <= best.distance + margin) {
      return stationary('ambiguous');
    }
    if (!withinReach && match.distance + margin < best.distance) return stationary('off-track');
  }
  const competing = competingSectionStatus(route, fix, best);
  if (competing) return stationary(competing);

  const remainingDistance = Math.max(0, route.distance - best.along);
  const [lng, lat] = route.coordinates.at(-1);
  const arrived = remainingDistance <= 7 && fix.accuracy <= 15 && route.accuracies.at(-1) <= 25 &&
    trackDistance(fix, {lng, lat}) <= 10;
  return {status:arrived ? 'arrived' : 'on-track', distanceFromStart:best.along, remainingDistance,
    coordinateIndex:best.index + Number(best.fraction === 1), timestamp:fix.timestamp};
}
