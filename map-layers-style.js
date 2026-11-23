const zoom = (...stops) => ['interpolate',['linear'],['zoom'],...stops];
export const houseFill = 'quiet-houses-fill';
export const houseNumbers = 'quiet-house-numbers';
export const satelliteLayer = 'quiet-satellite-image';
export const forestLayer = 'quiet-forest-cover';
export const fieldWayHits = ['quiet-field-crossings','quiet-field-ways','quiet-field-tracks','quiet-field-waterways'];
const terrainLayer = 'quiet-terrain-shading';
const contourLayer = 'quiet-terrain-contours';
const elevationLayer = 'quiet-terrain-elevations';

export const overlayStyles = {
  satellite: {
    before:'buildings',
    type:'raster',
    layers:[{
      id:satelliteLayer,type:'raster',source:'quiet-satellite',
      layout:{visibility:'none'},
      paint:{'raster-fade-duration':0,'raster-resampling':'linear'},
    }],
  },
  forest: {
    before:'water',
    type:'raster',
    layers:[{
      id:forestLayer,type:'raster',source:'quiet-forest',
      paint:{'raster-fade-duration':0,'raster-resampling':'linear'},
    }],
  },
  terrain: {
    before:'water',type:'raster',
    layers:[{
      id:terrainLayer,type:'raster',source:'quiet-terrain',layout:{visibility:'none'},
      paint:{'raster-opacity':.64,'raster-fade-duration':0,'raster-resampling':'linear'},
    }],
  },
  contours: {
    before:'tracks-casing',labelBefore:'park-names',type:'vector',
    layers:[{
      id:contourLayer,type:'line',source:'quiet-contours','source-layer':'contours',minzoom:8,
      layout:{visibility:'none'},
      paint:{'line-color':'#8a6445','line-width':['case',['==',['get','major'],true],1.2,.7],'line-opacity':.69},
    },{
      id:elevationLayer,type:'symbol',source:'quiet-contours','source-layer':'contours',minzoom:10,
      filter:['==',['get','major'],true],
      layout:{
        visibility:'none','symbol-placement':'line','symbol-spacing':300,
        'text-field':['concat',['to-string',['get','elevation']],' м'],
        'text-font':['Arial','Arial Bold'],'text-size':11,'text-padding':4,
      },
      paint:{'text-color':'#705037','text-halo-color':'#f9edcf','text-halo-width':1.15},
    }],
  },
  detail: {
    before:'oblast-boundaries',
    labelBefore:'district-labels',
    type:'vector',
    layers:[
      {
        id:houseFill,type:'fill',source:'quiet-detail','source-layer':'houses',minzoom:13,
        paint:{'fill-color':'#c4ab90','fill-opacity':zoom(13,.52,16,.91),'fill-outline-color':'#8c765f'},
      },{
        id:houseNumbers,type:'symbol',source:'quiet-detail','source-layer':'house_labels',minzoom:15.7,
        layout:{
          'text-field':['to-string',['get','number']],
          'text-font':['Arial Bold','Arial'],'text-size':zoom(15.7,10,18,12.5,20,14),
          'text-padding':2,
        },
        paint:{'text-color':'#4f4437','text-halo-color':'#fffaf0','text-halo-width':1.3},
      },
    ],
  },
  'field-ways': {
    before:'minor-casing',labelBefore:'district-labels',type:'vector',
    layers:[{
      id:'quiet-field-waterways',type:'line',source:'quiet-field-ways','source-layer':'field_waterways',
      minzoom:10,paint:{
        'line-color':'#4087a6','line-width':zoom(10,.5,13,1.15,16,2),
        'line-opacity':.8,
      },
    },{
      id:'quiet-field-track-casing',type:'line',source:'quiet-field-ways','source-layer':'field_ways',
      minzoom:11,filter:['==',['get','highway'],'track'],
      layout:{'line-join':'round','line-cap':'round'},
      paint:{'line-color':'#fff2d9','line-width':zoom(11,1.3,14,3.5,18,5.5),'line-opacity':.9},
    },{
      id:'quiet-field-tracks',type:'line',source:'quiet-field-ways','source-layer':'field_ways',
      minzoom:11,filter:['==',['get','highway'],'track'],
      layout:{'line-join':'round','line-cap':'round'},paint:{
        'line-color':['case',['==',['get','state'],'inactive'],'#8b7c6c','#a4662b'],
        'line-width':zoom(11,.65,14,1.45,18,2.65),
        'line-opacity':['case',['==',['get','state'],'inactive'],.48,.93],
      },
    },{
      id:'quiet-field-ways',type:'line',source:'quiet-field-ways','source-layer':'field_ways',
      filter:['!=',['get','highway'],'track'],
      minzoom:11,layout:{'line-join':'round','line-cap':'round'},
      paint:{
        'line-color':['case',['==',['get','state'],'inactive'],'#8b7c6c','#855838'],
        'line-width':zoom(11,.65,14,1.45,18,2.65),
        'line-dasharray':[2,1.5],
        'line-opacity':['case',['==',['get','state'],'inactive'],.48,.93],
      },
    },{
      id:'quiet-field-crossings',type:'circle',source:'quiet-field-ways','source-layer':'field_crossings',
      minzoom:13,paint:{
        'circle-radius':zoom(13,3,16,5),'circle-color':['match',['get','kind'],'ford','#a45528','#24668b'],
        'circle-stroke-color':'#fff','circle-stroke-width':1.15,
      },
    },{
      id:'quiet-field-way-labels',type:'symbol',source:'quiet-field-ways','source-layer':'field_ways',
      minzoom:14,filter:['all',['has','name'],['!=',['get','state'],'inactive']],
      layout:{
        'symbol-placement':'line','symbol-spacing':240,'text-field':['get','name'],
        'text-font':['Arial','Arial Bold'],'text-size':11,'text-padding':4,
      },
      paint:{'text-color':'#64482e','text-halo-color':'#fff9ee','text-halo-width':1.3},
    }],
  },
};

const geographicBackground = new Set(['sea','land','landcover','landuse','water','watercourses']);
const hybridLineOpacity = {
  'main-casing':.6,'main-roads':.82,'minor-casing':.55,'minor-roads':.66,
  'tracks-casing':.82,'tracks':.98,'ferries':.62,'rail':.66,'tunnels':.72,
};

const darkPaint = {
  sea:{'background-color':'#182c3e'},
  land:{'fill-color':'#1e2d30'},
  landcover:{'fill-color':'#284037'},
  landuse:{'fill-color':['match',['get','kind'],
    ['forest','wood','grass','park','nature_reserve','national_park','protected_area'],'#283d35',
    ['residential','neighbourhood'],'#303838',
    ['industrial','commercial','retail','construction'],'#353736',
    ['wetland','marsh'],'#314a45','rgba(0,0,0,0)']},
  water:{'fill-color':'#1a3046'},
  watercourses:{'line-color':'#4877a1'},
  buildings:{'fill-color':'#786d5d'},
  'minor-casing':{'line-color':'#1b2528'},'minor-roads':{'line-color':'#64645c'},
  'main-casing':{'line-color':'#242525'},'main-roads':{'line-color':'#b9965c'},
  tracks:{'line-color':'#d5b88f'},'tracks-casing':{'line-color':'#223239'},
  rail:{'line-color':'#a09083'},tunnels:{'line-color':'#a3937a'},
};

const forestPaint = {
  landcover:{'fill-opacity':zoom(5,.77,10,.5,16,.31,20,.22)},
  watercourses:{'line-color':'#4489a9','line-width':zoom(7,.65,11,1.4,15,2.5,18,4.4)},
};

const contrastPaint = {
  sea:{'background-color':'#9fc9df'},land:{'fill-color':'#f7f4e6'},
  landcover:{'fill-color':'#8ebf80','fill-opacity':.82},water:{'fill-color':'#a2cce5'},
  watercourses:{'line-color':'#145575','line-width':zoom(7,1,11,1.9,15,3.0,18,4.7)},
  'main-casing':{'line-color':'#815727'},'main-roads':{'line-color':'#ffc468'},
  'minor-casing':{'line-color':'#a69979'},'minor-roads':{'line-color':'#fffaf0'},
  tracks:{'line-color':'#653925','line-width':zoom(10,.85,13,1.8,16,3.0,18,4.0)},
  'tracks-casing':{'line-color':'#fff4d7'},
};

function visible(map,id,enabled) {
  const visibility = enabled ? 'visible' : 'none';
  if (map.getLayer(id) && map.getLayoutProperty(id,'visibility') !== visibility) {
    map.setLayoutProperty(id,'visibility',visibility);
  }
}

export function applyOverlayMode(map,layers,{mode,forest,detail,field}) {
  const photo = mode === 'satellite' || mode === 'hybrid';
  const hybrid = mode === 'hybrid';
  const dark = mode === 'dark';
  const contrast = mode === 'outdoor';
  const outdoor = mode === 'forest' || mode === 'topographic' || contrast;
  for (const layer of layers) {
    const geography = geographicBackground.has(layer.id);
    const outlines = !photo || hybrid;
    visible(map,layer.id,geography || (outlines && (layer.id !== 'buildings' || !detail)));
    if (layer.type === 'symbol') {
      map.setPaintProperty(layer.id,'text-color',hybrid || dark ? '#f6eee0' : contrast ? '#19261c' : layer.paint['text-color']);
      map.setPaintProperty(layer.id,'text-halo-color',hybrid || dark ? '#1a2728' : contrast ? '#fffff3' : layer.paint['text-halo-color']);
      map.setPaintProperty(layer.id,'text-halo-width',hybrid || dark || contrast ? 1.45 : layer.paint['text-halo-width']);
    }
    if (Object.hasOwn(hybridLineOpacity,layer.id)) {
      map.setPaintProperty(layer.id,'line-opacity',hybrid ? hybridLineOpacity[layer.id] : layer.paint['line-opacity'] ?? null);
      if (layer.id === 'tracks') map.setPaintProperty(layer.id,'line-color',hybrid ? '#ffe495' : layer.paint['line-color']);
      if (hybrid && layer.id.endsWith('casing')) map.setPaintProperty(layer.id,'line-color','#273231');
      else if (layer.id.endsWith('casing')) map.setPaintProperty(layer.id,'line-color',layer.paint['line-color']);
    }
    const darkProps = darkPaint[layer.id] || {};
    const outdoorProps = forestPaint[layer.id] || {};
    const contrastProps = contrastPaint[layer.id] || {};
    for (const property of new Set([...Object.keys(darkProps),...Object.keys(outdoorProps),...Object.keys(contrastProps)])) {
      if (hybrid && layer.id.startsWith('tracks') && property === 'line-color') continue;
      if (hybrid && layer.id.endsWith('casing') && property === 'line-color') continue;
      map.setPaintProperty(layer.id,property,(dark ? darkProps[property] : contrast ? contrastProps[property] : outdoor ? outdoorProps[property] : undefined) ??
        layer.paint[property] ?? null);
    }
  }
  visible(map,satelliteLayer,photo);
  visible(map,forestLayer,(mode === 'map' || outdoor) && forest);
  visible(map,terrainLayer,mode === 'topographic');
  visible(map,contourLayer,mode === 'topographic');
  visible(map,elevationLayer,mode === 'topographic');
  visible(map,houseFill,mode !== 'satellite');
  visible(map,houseNumbers,mode !== 'satellite');
  if (field) {
    for (const layer of overlayStyles['field-ways'].layers) visible(map,layer.id,mode !== 'satellite');
    map.setPaintProperty('quiet-field-waterways','line-color',dark || hybrid ? '#79bedc' : '#4087a6');
    map.setPaintProperty('quiet-field-way-labels','text-color',dark || hybrid ? '#ffedc3' : '#64482e');
    map.setPaintProperty('quiet-field-way-labels','text-halo-color',dark || hybrid ? '#233332' : '#fff9ee');
  }
  if (map.getLayer(houseFill)) {
    map.setPaintProperty(houseFill,'fill-opacity',hybrid ? .14 : overlayStyles.detail.layers[0].paint['fill-opacity']);
    map.setPaintProperty(houseFill,'fill-color',dark ? '#806f5b' : contrast ? '#c9ae91' : overlayStyles.detail.layers[0].paint['fill-color']);
    map.setPaintProperty(houseFill,'fill-outline-color',hybrid ? '#ffd28c' : dark ? '#a59174' : contrast ? '#665139' : '#8c765f');
  }
  if (map.getLayer(houseNumbers)) {
    map.setPaintProperty(houseNumbers,'text-color',hybrid || dark ? '#fff8de' : '#4f4437');
    map.setPaintProperty(houseNumbers,'text-halo-color',hybrid || dark ? '#182625' : '#fffaf0');
  }
}
