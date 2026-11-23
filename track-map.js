const source = 'quiet-trip';
const filter = kind => ['==',['get','kind'],kind];
const point = fix => [fix.lng,fix.lat];

function line(id,kind,color,width,additional = {}) {
  return {
    id,type:'line',source,filter:filter(kind),
    layout:{'line-join':'round','line-cap':'round'},
    paint:{'line-color':color,'line-width':width,...additional},
  };
}

function feature(kind,type,coordinates) {
  return {type:'Feature',properties:{kind},geometry:{type,coordinates}};
}

export function paintTrack(map,track,route) {
  if (!map) return;
  const features = [];
  for (const section of track?.segments || []) {
    if (section.length > 1) features.push(feature('recorded','LineString',section.map(point)));
    if (section.length) features.push(feature('start','Point',point(section[0])));
  }
  if (route?.coordinates.length > 1) {
    features.push(feature('return','LineString',route.coordinates));
    features.push(feature('return-end','Point',route.coordinates.at(-1)));
  }
  const data = {type:'FeatureCollection',features};
  const existing = map.getSource(source);
  if (existing) {
    existing.setData(data);
    return;
  }
  map.addSource(source,{type:'geojson',data});
  const before = map.getLayer('quiet-directions-casing') ? 'quiet-directions-casing' : undefined;
  map.addLayer(line('trip-recorded-casing','recorded','#fff9e6',6),before);
  map.addLayer(line('trip-recorded-line','recorded','#a76b29',3.5),before);
  map.addLayer(line('trip-return-casing','return','#f0fffa',9),before);
  map.addLayer(line('trip-return-line','return','#00665d',5.5),before);
  map.addLayer({
    id:'trip-return-arrows',type:'symbol',source,filter:filter('return'),
    layout:{
      'symbol-placement':'line','symbol-spacing':78,'text-field':'›','text-size':26,
      'text-font':['Arial Bold','Arial'],'text-keep-upright':false,'text-allow-overlap':true,
    },
    paint:{'text-color':'#fff','text-halo-color':'#00665d','text-halo-width':1.5},
  },before);
  map.addLayer({
    id:'trip-section-start',type:'circle',source,filter:filter('start'),
    paint:{'circle-radius':5.5,'circle-color':'#a76b29','circle-stroke-color':'#fff','circle-stroke-width':2},
  },before);
  map.addLayer({
    id:'trip-return-end',type:'circle',source,filter:filter('return-end'),
    paint:{'circle-radius':8,'circle-color':'#00665d','circle-stroke-color':'#fff','circle-stroke-width':2.5},
  },before);
}

export function fitTrack(map,sections) {
  if (!map) return false;
  const box = [[Infinity,Infinity],[-Infinity,-Infinity]];
  for (const section of sections) {
    for (const [lng,lat] of section) {
      box[0][0] = Math.min(box[0][0],lng);
      box[0][1] = Math.min(box[0][1],lat);
      box[1][0] = Math.max(box[1][0],lng);
      box[1][1] = Math.max(box[1][1],lat);
    }
  }
  if (!Number.isFinite(box[0][0])) return false;
  const {clientWidth,clientHeight} = map.getContainer();
  const padding = Math.min(55,Math.round(Math.min(clientWidth,clientHeight) / 5));
  map.fitBounds(box,{padding,maxZoom:17.5,duration:270});
  return true;
}
