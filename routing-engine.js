const METERS_PER_DEGREE = 111195;
const ROAD_CELL_METERS = 1000;
const ROUNDABOUT = 1;
const DESTINATION_ACCESS = 2;
const UNCERTAIN_ACCESS_OR_TERRAIN = 4;
const SNAP_START_METERS = 350;
const SNAP_GOAL_METERS = 500;
const WALK_SNAP_START_METERS = 40;
const WALK_SNAP_GOAL_METERS = 80;
const SNAP_CORRECTION_METERS = 25;
const SNAP_CORRECTION_LIMIT = 80;
const EXACT_SNAP_METERS = 5;
const MAX_SNAP_ALTERNATIVES = 5;
const MAX_CORRECTION_SEARCHES = 12;
const U_TURN_SECONDS = 20;

function validPoint(point) {
  return Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])
    && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;
}

function longitudeScale(latitude) {
  return Math.max(1, METERS_PER_DEGREE * Math.cos(latitude * Math.PI / 180));
}

function projectToSegment(point, from, to, scale) {
  const dx = (to[0] - from[0]) * scale;
  const dy = (to[1] - from[1]) * METERS_PER_DEGREE;
  const x = (point[0] - from[0]) * scale;
  const y = (point[1] - from[1]) * METERS_PER_DEGREE;
  const lengthSquared = dx * dx + dy * dy;
  const fraction = lengthSquared ? Math.max(0, Math.min(1, (x * dx + y * dy) / lengthSquared)) : 0;
  return { fraction, distanceSquared: (x - fraction * dx) ** 2 + (y - fraction * dy) ** 2 };
}

function routingError(code, message) {
  return Object.assign(new Error(message), { code });
}

function invalidGraph() {
  return new Error('Неверный формат дорожного графа.');
}

function findRoot(parents, node) {
  while (parents[node] !== node) {
    parents[node] = parents[parents[node]];
    node = parents[node];
  }
  return node;
}

function roadGraph(data) {
  if (data?.schema !== 1 || !Array.isArray(data.nodes) || !Array.isArray(data.edges)
    || !Array.isArray(data.names) || !Array.isArray(data.blocked)) throw invalidGraph();
  const profile = data.profile ?? 'car';
  if (profile !== 'car' && profile !== 'walk') throw invalidGraph();
  const { nodes, edges, names } = data;
  const edgeCount = edges.length;
  const from = new Uint32Array(edgeCount);
  const to = new Uint32Array(edgeCount);
  const meters = new Float64Array(edgeCount);
  const seconds = new Float64Array(edgeCount);
  const nameIndex = new Int32Array(edgeCount);
  const flags = new Uint8Array(edgeCount);
  const offsets = new Uint32Array(nodes.length + 1);
  const outgoing = new Uint32Array(edgeCount);
  const accessGroups = new Int32Array(nodes.length).fill(-1);
  const components = new Int32Array(nodes.length);
  const x = new Float64Array(nodes.length);
  const y = new Float64Array(nodes.length);
  let south = Infinity;
  let north = -Infinity;
  for (const node of nodes) {
    if (!validPoint(node)) throw invalidGraph();
    south = Math.min(south, node[1]);
    north = Math.max(north, node[1]);
  }
  const scale = longitudeScale(nodes.length ? (south + north) / 2 : 0);
  for (let node = 0; node < nodes.length; node++) {
    x[node] = nodes[node][0] * scale;
    y[node] = nodes[node][1] * METERS_PER_DEGREE;
    components[node] = node;
  }

  let minimumSecondsPerMeter = Infinity;
  for (let edge = 0; edge < edgeCount; edge++) {
    if (!Array.isArray(edges[edge])) throw invalidGraph();
    const [start, end, length, speed, , name, properties] = edges[edge];
    if (!Number.isInteger(start) || start < 0 || start >= nodes.length
      || !Number.isInteger(end) || end < 0 || end >= nodes.length
      || !Number.isFinite(length) || length < 0 || !Number.isFinite(speed) || speed <= 0) {
      throw invalidGraph();
    }
    from[edge] = start;
    to[edge] = end;
    meters[edge] = length;
    seconds[edge] = length * 3.6 / speed;
    nameIndex[edge] = Number.isInteger(name) ? name : -1;
    flags[edge] = properties;
    offsets[start + 1]++;
    components[findRoot(components, start)] = findRoot(components, end);
    const straightDistance = Math.hypot(x[end] - x[start], y[end] - y[start]);
    if (straightDistance) {
      minimumSecondsPerMeter = Math.min(minimumSecondsPerMeter, seconds[edge] / straightDistance);
    }
    if (flags[edge] & DESTINATION_ACCESS) {
      if (accessGroups[start] < 0) accessGroups[start] = start;
      if (accessGroups[end] < 0) accessGroups[end] = end;
      accessGroups[findRoot(accessGroups, start)] = findRoot(accessGroups, end);
    }
  }
  for (let node = 0; node < nodes.length; node++) {
    offsets[node + 1] += offsets[node];
    if (accessGroups[node] >= 0) accessGroups[node] = findRoot(accessGroups, node);
    components[node] = findRoot(components, node);
  }
  const cursor = offsets.slice();
  for (let edge = 0; edge < edgeCount; edge++) outgoing[cursor[from[edge]]++] = edge;
  return { profile, nodes, names, edgeCount, from, to, meters, seconds, nameIndex, flags, offsets, outgoing,
    accessGroups, components, x, y, scale, south, north,
    minimumSecondsPerMeter: Number.isFinite(minimumSecondsPerMeter) ? minimumSecondsPerMeter : 0 };
}

function roadIndex(graph) {
  const cells = new Map();
  const longEdges = [];
  const cell = value => Math.floor(value / ROAD_CELL_METERS);
  const key = (column, row) => `${column},${row}`;

  for (let edge = 0; edge < graph.edgeCount; edge++) {
    const start = graph.from[edge];
    const end = graph.to[edge];
    const west = cell(Math.min(graph.x[start], graph.x[end]));
    const east = cell(Math.max(graph.x[start], graph.x[end]));
    const south = cell(Math.min(graph.y[start], graph.y[end]));
    const north = cell(Math.max(graph.y[start], graph.y[end]));
    if ((north - south + 1) * (east - west + 1) > 64) {
      longEdges.push(edge);
      continue;
    }
    for (let row = south; row <= north; row++) {
      for (let column = west; column <= east; column++) {
        const id = key(column, row);
        let bucket = cells.get(id);
        if (!bucket) cells.set(id, bucket = []);
        bucket.push(edge);
      }
    }
  }

  function scan(point, limit, visit) {
    const latitudePadding = limit / METERS_PER_DEGREE;
    if (point[1] < graph.south - latitudePadding || point[1] > graph.north + latitudePadding) return;
    const scale = longitudeScale(point[1]);
    const x = point[0] * graph.scale;
    const y = point[1] * METERS_PER_DEGREE;
    const xPadding = limit * graph.scale / scale;
    const limitSquared = limit * limit;

    function compareEdges(edges) {
      for (const edge of edges) {
        const result = projectToSegment(point, graph.nodes[graph.from[edge]], graph.nodes[graph.to[edge]], scale);
        if (result.distanceSquared <= limitSquared) visit(edge, result);
      }
    }

    for (let row = cell(y - limit); row <= cell(y + limit); row++) {
      for (let column = cell(x - xPadding); column <= cell(x + xPadding); column++) {
        const bucket = cells.get(key(column, row));
        if (bucket) compareEdges(bucket);
      }
    }
    compareEdges(longEdges);
  }

  function candidateFor(edge, { fraction, distanceSquared }) {
    const from = graph.from[edge];
    const to = graph.to[edge];
    let node = -1;
    if (fraction <= 1e-9) node = from;
    if (fraction >= 1 - 1e-9) node = to;
    const id = node >= 0 ? node : `${Math.min(from, to)}:${Math.max(from, to)}`;
    return { edge, from, to, fraction, distanceSquared, node, id };
  }

  function makeSnap({ from, to, fraction, distanceSquared, node, id }, corrected = false) {
    const distance = Math.sqrt(distanceSquared);
    const component = graph.components[from];
    if (node >= 0) return { point: graph.nodes[node], node, edges: [], id, distance, component, corrected };
    const [a, b] = [graph.nodes[from], graph.nodes[to]];
    const coordinate = [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
    const edges = [];
    for (const [start, end, offset] of [[from, to, fraction], [to, from, 1 - fraction]]) {
      for (let i = graph.offsets[start]; i < graph.offsets[start + 1]; i++) {
        const edge = graph.outgoing[i];
        if (graph.to[edge] === end) edges.push([edge, offset]);
      }
    }
    return { point: coordinate, node, edges, id, distance, component, corrected };
  }

  function order(a, b) {
    return a.distanceSquared - b.distanceSquared || a.edge - b.edge;
  }

  return {
    nearest(point, limit) {
      let best = null;
      scan(point, limit, (edge, result) => {
        if (!best || result.distanceSquared < best.distanceSquared
          || (result.distanceSquared === best.distanceSquared && edge < best.edge)) best = candidateFor(edge, result);
      });
      return best && makeSnap(best);
    },
    corrections(point, nearest) {
      if (nearest.distance <= EXACT_SNAP_METERS || nearest.distance >= SNAP_CORRECTION_LIMIT) return [];
      const limit = Math.min(SNAP_CORRECTION_LIMIT, nearest.distance + SNAP_CORRECTION_METERS);
      const candidates = new Map();
      scan(point, limit, (edge, result) => {
        if (graph.flags[edge] & DESTINATION_ACCESS) return;
        const candidate = candidateFor(edge, result);
        if (candidate.id === nearest.id) return;
        const known = candidates.get(candidate.id);
        if (!known || order(candidate, known) < 0) candidates.set(candidate.id, candidate);
      });
      return [...candidates.values()].sort(order).slice(0, MAX_SNAP_ALTERNATIVES)
        .map(candidate => makeSnap(candidate, true));
    }
  };
}

function turnRules(sequences, edgeCount) {
  const trie = [{ next: new Map(), failure: 0, blocked: false, depth: 0 }];
  for (const sequence of sequences) {
    if (!Array.isArray(sequence) || sequence.length < 2) throw invalidGraph();
    let prefix = 0;
    for (const edge of sequence) {
      if (!Number.isInteger(edge) || edge < 0 || edge >= edgeCount) throw invalidGraph();
      const state = trie[prefix];
      if (!state.next.has(edge)) {
        state.next.set(edge, trie.length);
        trie.push({ next: new Map(), failure: 0, blocked: false, depth: state.depth + 1, edge });
      }
      prefix = state.next.get(edge);
    }
    trie[prefix].blocked = true;
  }

  // A forbidden sequence can begin while another sequence's prefix is being matched.
  const rootChildren = new Uint32Array(edgeCount);
  for (const [edge, prefix] of trie[0].next) rootChildren[edge] = prefix;
  const order = [...trie[0].next.values()];
  for (let i = 0; i < order.length; i++) {
    const state = trie[order[i]];
    for (const [edge, child] of state.next) {
      let suffix = state.failure;
      while (suffix && !trie[suffix].next.has(edge)) suffix = trie[suffix].failure;
      const failure = trie[suffix].next.get(edge) ?? 0;
      trie[child].failure = failure;
      trie[child].blocked ||= trie[failure].blocked;
      order.push(child);
    }
  }

  return {
    stateCount: edgeCount + trie.length,
    // A single incoming edge already fixes any length-one prefix. Only longer prefixes need extra states.
    routeState: (edge, prefix) => trie[prefix].depth < 2 ? edge : edgeCount + prefix,
    incoming: state => state < edgeCount ? state : trie[state - edgeCount].edge,
    prefix: state => state < edgeCount ? rootChildren[state] : state - edgeCount,
    advance(prefix, edge) {
      while (prefix && !trie[prefix].next.has(edge)) prefix = trie[prefix].failure;
      const next = prefix ? trie[prefix].next.get(edge) : rootChildren[edge];
      return trie[next].blocked ? -1 : next;
    }
  };
}

class MinHeap {
  states = [];
  priorities = [];

  push(state, priority) {
    let index = this.states.length;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.priorities[parent] <= priority) break;
      this.states[index] = this.states[parent];
      this.priorities[index] = this.priorities[parent];
      index = parent;
    }
    this.states[index] = state;
    this.priorities[index] = priority;
  }

  pop() {
    const state = this.states[0];
    const last = this.states.pop();
    const priority = this.priorities.pop();
    const length = this.states.length;
    if (!length) return state;
    let index = 0;
    while (index * 2 + 1 < length) {
      let child = index * 2 + 1;
      if (child + 1 < length && this.priorities[child + 1] < this.priorities[child]) child++;
      if (this.priorities[child] >= priority) break;
      this.states[index] = this.states[child];
      this.priorities[index] = this.priorities[child];
      index = child;
    }
    this.states[index] = last;
    this.priorities[index] = priority;
    return state;
  }
}

function accessGroup(graph, snap) {
  if (snap.corrected) return -1;
  if (snap.node >= 0) return graph.accessGroups[snap.node];
  for (const [edge] of snap.edges) {
    if (graph.flags[edge] & DESTINATION_ACCESS) return graph.accessGroups[graph.from[edge]];
  }
  return -1;
}

function choosePath(graph, rules, roads, start, goal, firstStart, firstEnd) {
  function attempt(snapStart, snapEnd) {
    if (snapStart.component !== snapEnd.component) return null;
    const startGroup = accessGroup(graph, snapStart);
    const endGroup = accessGroup(graph, snapEnd);
    function available(edge) {
      if (!(graph.flags[edge] & DESTINATION_ACCESS)) return true;
      const group = graph.accessGroups[graph.from[edge]];
      return group === startGroup || group === endGroup;
    }
    const path = pathBetween(graph, rules, snapStart, snapEnd, available);
    return path && { ...path, snapStart, snapEnd, available };
  }

  const first = attempt(firstStart, firstEnd);
  if (first) return first;
  // A farther path can lie across a fence or on another level of the crossing.
  if (graph.profile === 'walk') {
    throw routingError('no-route', 'Между этими точками нет доступного пешеходного маршрута.');
  }

  // A nearby public approach can still serve a point whose closest spur is isolated or gated.
  const starts = [firstStart, ...roads.corrections(start, firstStart)];
  const ends = [firstEnd, ...roads.corrections(goal, firstEnd)];
  const candidates = [];
  for (const snapStart of starts) {
    for (const snapEnd of ends) {
      if (!snapStart.corrected && !snapEnd.corrected) continue;
      if (snapStart.component === snapEnd.component) candidates.push([snapStart, snapEnd]);
    }
  }
  candidates.sort(([a, b], [c, d]) => a.distance + b.distance - c.distance - d.distance);
  for (const [snapStart, snapEnd] of candidates.slice(0, MAX_CORRECTION_SEARCHES)) {
    const path = attempt(snapStart, snapEnd);
    if (path) return path;
  }
  throw routingError('no-route', 'Между этими точками нет доступного автомобильного маршрута.');
}

function pathBetween(graph, rules, start, goal, available) {
  if (start.node >= 0 && start.node === goal.node) return { parts: [], seconds: 0 };

  const firstFractions = new Map(start.edges);
  const lastFractions = new Map(goal.edges);
  const costs = new Float64Array(rules.stateCount).fill(Infinity);
  const parents = new Int32Array(rules.stateCount);
  const queue = new MinHeap();
  const goalX = goal.point[0] * graph.scale;
  const goalY = goal.point[1] * METERS_PER_DEGREE;
  const uTurnSeconds = graph.profile === 'walk' ? 0 : U_TURN_SECONDS;
  let best = null;

  // The least time per projected meter across the entire graph is an admissible lower bound.
  function estimate(node) {
    return graph.minimumSecondsPerMeter * Math.hypot(graph.x[node] - goalX, graph.y[node] - goalY);
  }

  function offer(edge, prefix, cost, parent) {
    const state = rules.routeState(edge, prefix);
    if (cost >= costs[state]) return;
    costs[state] = cost;
    parents[state] = parent;
    queue.push(state, cost + estimate(graph.to[edge]));
  }

  function consider(cost, state, lastPart = null) {
    if (!best || cost < best.cost) best = { cost, state, lastPart };
  }

  if (start.node >= 0) {
    for (let i = graph.offsets[start.node]; i < graph.offsets[start.node + 1]; i++) {
      const edge = graph.outgoing[i];
      if (!available(edge)) continue;
      const last = lastFractions.get(edge);
      if (last !== undefined) consider(graph.seconds[edge] * last, -1, [edge, 0, last]);
      offer(edge, rules.advance(0, edge), graph.seconds[edge], -1);
    }
  } else {
    for (const [edge, first] of start.edges) {
      if (!available(edge)) continue;
      const last = lastFractions.get(edge);
      if (last >= first) {
        const fraction = last - first;
        consider(graph.seconds[edge] * fraction, -1, fraction ? [edge, first, last] : null);
      }
      offer(edge, rules.advance(0, edge), graph.seconds[edge] * (1 - first), -1);
    }
  }

  while (queue.states.length) {
    const priority = queue.priorities[0];
    if (best && priority >= best.cost) break;
    const state = queue.pop();
    const incoming = rules.incoming(state);
    const node = graph.to[incoming];
    const cost = costs[state];
    if (priority > cost + estimate(node)) continue;
    if (node === goal.node) {
      consider(cost, state);
      continue;
    }
    const prefix = rules.prefix(state);
    for (let i = graph.offsets[node]; i < graph.offsets[node + 1]; i++) {
      const edge = graph.outgoing[i];
      if (!available(edge)) continue;
      const next = rules.advance(prefix, edge);
      if (next < 0) continue;
      const turn = graph.to[edge] === graph.from[incoming] ? uTurnSeconds : 0;
      const last = lastFractions.get(edge);
      if (last !== undefined) consider(cost + turn + graph.seconds[edge] * last, state, [edge, 0, last]);
      offer(edge, next, cost + turn + graph.seconds[edge], state);
    }
  }

  if (!best) return null;
  const parts = best.lastPart ? [best.lastPart] : [];
  for (let state = best.state; state >= 0; state = parents[state]) {
    const edge = rules.incoming(state);
    const first = parents[state] < 0 ? firstFractions.get(edge) ?? 0 : 0;
    parts.push([edge, first, 1]);
  }
  parts.reverse();
  return { parts, seconds: best.cost };
}

function roadName(graph, edge) {
  return graph.names[graph.nameIndex[edge]] || '';
}

function maneuverAngle(a, b, c) {
  const scale = longitudeScale(b[1]) / METERS_PER_DEGREE;
  const incomingX = (b[0] - a[0]) * scale;
  const incomingY = b[1] - a[1];
  const outgoingX = (c[0] - b[0]) * scale;
  const outgoingY = c[1] - b[1];
  return Math.atan2(incomingX * outgoingY - incomingY * outgoingX,
    incomingX * outgoingX + incomingY * outgoingY) * 180 / Math.PI;
}

function routeSteps(graph, parts, coordinates, cumulativeDistances, available) {
  const steps = [];
  const walking = graph.profile === 'walk';
  const path = walking ? 'по пути' : 'по дороге';
  const turnOnto = walking ? 'на путь' : 'на дорогу';
  function add(type, label, coordinateIndex, exitNumber) {
    const step = { type, label, coordinateIndex, distanceFromStart: cumulativeDistances[coordinateIndex] };
    if (exitNumber !== undefined) step.exitNumber = exitNumber;
    steps.push(step);
  }

  const firstName = parts.length ? roadName(graph, parts[0][0]) : '';
  if (parts.length) {
    add('depart', firstName ? `Начните движение ${path} «${firstName}»` : 'Начните движение по маршруту', 0);
  }
  for (let index = 0; index < parts.length; index++) {
    const edge = parts[index][0];
    if (!walking && (graph.flags[edge] & ROUNDABOUT)) {
      let exitIndex = index + 1;
      let exitNumber = 0;
      for (; exitIndex < parts.length; exitIndex++) {
        const incoming = parts[exitIndex - 1][0];
        const node = graph.to[incoming];
        for (let i = graph.offsets[node]; i < graph.offsets[node + 1]; i++) {
          const option = graph.outgoing[i];
          if (!(graph.flags[option] & ROUNDABOUT) && available(option) && graph.to[option] !== graph.from[incoming]) {
            exitNumber++;
            break;
          }
        }
        if (!(graph.flags[parts[exitIndex][0]] & ROUNDABOUT)) break;
      }
      if (exitIndex < parts.length) {
        const name = roadName(graph, parts[exitIndex][0]);
        const exit = Math.max(1, exitNumber);
        const destination = name ? ` на дорогу «${name}»` : '';
        add('roundabout', `На круговом движении воспользуйтесь ${exit}-м съездом${destination}`, index, exit);
      } else if (index > 0) {
        add('roundabout', 'Въезжайте на круговое движение', index);
      }
      index = exitIndex;
      continue;
    }
    if (!index) continue;
    const incoming = parts[index - 1][0];
    const node = graph.from[edge];
    const name = roadName(graph, edge);
    const changedName = name && name !== roadName(graph, incoming);
    const reverses = graph.to[edge] === graph.from[incoming];
    let junction = false;
    for (let i = graph.offsets[node]; i < graph.offsets[node + 1]; i++) {
      const alternative = graph.outgoing[i];
      if (graph.to[alternative] !== graph.from[incoming] && graph.to[alternative] !== graph.to[edge]
        && available(alternative)) {
        junction = true;
        break;
      }
    }
    const angle = maneuverAngle(coordinates[index - 1], coordinates[index], coordinates[index + 1]);
    const magnitude = Math.abs(angle);
    if (reverses || (magnitude >= 155 && (junction || changedName))) {
      add('u-turn', name && !walking ? `Развернитесь на дороге «${name}»` : 'Развернитесь', index);
    } else if (magnitude >= 45 && (junction || changedName)) {
      add(angle > 0 ? 'left' : 'right',
        `Поверните ${angle > 0 ? 'налево' : 'направо'}${name ? ` ${turnOnto} «${name}»` : ''}`, index);
    } else if (magnitude >= 18 && junction) {
      add(angle > 0 ? 'slight-left' : 'slight-right',
        `Держитесь ${angle > 0 ? 'левее' : 'правее'}${name ? `, далее ${path} «${name}»` : ''}`, index);
    } else if (junction && changedName) {
      add('straight', `Двигайтесь прямо ${path} «${name}»`, index);
    }
  }
  add('arrive', walking ? 'Конец пешеходного маршрута' : 'Вы прибыли', coordinates.length - 1);
  return steps;
}

export function createRouter(data) {
  const graph = roadGraph(data);
  const roads = roadIndex(graph);
  const rules = turnRules(data.blocked, graph.edgeCount);
  const walking = graph.profile === 'walk';
  return {
    route(start, goal) {
      if (!validPoint(start) || !validPoint(goal)) throw routingError('invalid-point', 'Неверные координаты точки.');
      const firstStart = roads.nearest(start, walking ? WALK_SNAP_START_METERS : SNAP_START_METERS);
      if (!firstStart) throw routingError('no-start-road', walking ? 'Рядом с вашей позицией нет пешеходного пути.' :
        'Рядом с вашей позицией нет автомобильной дороги.');
      const firstEnd = roads.nearest(goal, walking ? WALK_SNAP_GOAL_METERS : SNAP_GOAL_METERS);
      if (!firstEnd) throw routingError('no-goal-road', walking ? 'Рядом с точкой назначения нет пешеходного пути.' :
        'Рядом с адресом нет автомобильной дороги.');

      const { snapStart, snapEnd, available, parts, seconds } = choosePath(graph, rules, roads, start, goal, firstStart, firstEnd);
      const startCoordinate = snapStart.point.slice(0, 2);
      const endCoordinate = snapEnd.point.slice(0, 2);
      const coordinates = [startCoordinate];
      const cumulativeDistances = [0];
      let distance = 0;
      let usesUncertain = false;
      for (let index = 0; index < parts.length; index++) {
        const [edge, from, to] = parts[index];
        distance += graph.meters[edge] * (to - from);
        if (walking && to > from && (graph.flags[edge] & UNCERTAIN_ACCESS_OR_TERRAIN)) usesUncertain = true;
        cumulativeDistances.push(distance);
        coordinates.push(index === parts.length - 1 ? endCoordinate : graph.nodes[graph.to[edge]].slice(0, 2));
      }
      const steps = routeSteps(graph, parts, coordinates, cumulativeDistances, available);
      return { profile: graph.profile, coordinates, cumulativeDistances, distance, seconds, steps, usesUncertain,
        snapStart: startCoordinate, snapEnd: endCoordinate,
        snapStartDistance: snapStart.distance, snapEndDistance: snapEnd.distance };
    }
  };
}

function walkingMatch(route, point, scale, hint, anchor, {elapsed = 0, accuracy = 0} = {}) {
  const { coordinates, cumulativeDistances } = route;
  const limit = 85;
  const reach = Math.min(limit, 14 + 3.5 * Math.max(0, elapsed) / 1000);
  const uncertainty = Math.max(8, accuracy + 2);
  let from = hint;
  let to = hint + 1;
  while (from > 0 && anchor - cumulativeDistances[from] <= limit) from--;
  while (to < coordinates.length - 1 && cumulativeDistances[to] - anchor <= limit) to++;
  const nearby = [];
  let best;

  for (let index = from; index < to; index++) {
    const projection = projectToSegment(point, coordinates[index], coordinates[index + 1], scale);
    const part = cumulativeDistances[index + 1] - cumulativeDistances[index];
    const along = cumulativeDistances[index] + part * projection.fraction;
    const displacement = Math.abs(along - anchor);
    if (displacement > limit) continue;

    const distance = Math.sqrt(projection.distanceSquared);
    if (distance <= uncertainty) nearby.push({along, distance});
    if (displacement > reach) continue;
    const score = projection.distanceSquared + (displacement * 0.2) ** 2;
    if (!best || score < best.score) {
      best = {coordinateIndex: index, distanceFromStart: along, distanceSquared: projection.distanceSquared, distance, score};
    }
  }

  // Close projections can be far apart along the route at a crossing or a switchback.
  const ambiguous = nearby.some(match => !best || best.distance > uncertainty ||
    Math.abs(match.along - best.distanceFromStart) > match.distance + best.distance + 8);
  return {
    coordinateIndex: best?.coordinateIndex ?? hint,
    distanceFromStart: best?.distanceFromStart ?? anchor,
    distanceSquared: best?.distanceSquared ?? Infinity,
    ambiguous,
  };
}

export function routeProgress(route, point, fromIndex = 0, lastDistance, walkingFix) {
  if (!validPoint(point) || !route?.coordinates?.length || !route.cumulativeDistances) return null;
  const { coordinates, cumulativeDistances } = route;
  const scale = longitudeScale(point[1]);
  const walking = route.profile === 'walk';
  let coordinateIndex = 0;
  let distanceFromStart = 0;
  let distanceSquared = Infinity;
  let ambiguous = false;
  const last = coordinates.length - 1;
  const hint = Number.isFinite(fromIndex) ? Math.max(0, Math.min(last - 1, Math.trunc(fromIndex))) : 0;

  if (!last) {
    distanceSquared = projectToSegment(point, coordinates[0], coordinates[0], scale).distanceSquared;
  } else if (walking) {
    const anchor = Number.isFinite(lastDistance) ? lastDistance : cumulativeDistances[hint];
    ({coordinateIndex, distanceFromStart, distanceSquared, ambiguous} = walkingMatch(route, point, scale, hint, anchor, walkingFix));
  } else {
    function match(from, to) {
      for (let index = from; index < to; index++) {
        const projection = projectToSegment(point, coordinates[index], coordinates[index + 1], scale);
        if (projection.distanceSquared >= distanceSquared) continue;
        distanceSquared = projection.distanceSquared;
        coordinateIndex = index;
        const part = cumulativeDistances[index + 1] - cumulativeDistances[index];
        distanceFromStart = cumulativeDistances[index] + part * projection.fraction;
      }
    }

    let from = hint;
    let to = hint + 1;
    while (from > 0 && cumulativeDistances[hint] - cumulativeDistances[from - 1] <= 80) from--;
    while (to < last && cumulativeDistances[to] - cumulativeDistances[hint] <= 1500) to++;
    match(from, to);
    if (distanceSquared > 60 ** 2) match(to, last);
  }

  const nextStep = route.steps.find(step => step.type !== 'depart' && step.distanceFromStart + 6 >= distanceFromStart) ?? null;
  const progress = {
    coordinateIndex, distanceFromRoute: Math.sqrt(distanceSquared), distanceFromStart,
    remainingDistance: Math.max(0, route.distance - distanceFromStart), nextStep,
    distanceToNextStep: nextStep ? Math.max(0, nextStep.distanceFromStart - distanceFromStart) : 0
  };
  if (walking) progress.ambiguous = ambiguous;
  return progress;
}
