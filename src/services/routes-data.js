import centres from './centres-data.js';

export const getCentres = () => centres;
export const findCentreById = (centreId) => centres.find((centre) => centre.id === centreId);
export const getRouteLabels = (centre, isAdi = false) => Array.from({ length: isAdi ? 7 : 15 }, (_, index) => `${isAdi ? 'ADI Route' : 'Standard Route'} ${index + 1}`);

const centreStreets = {
  Pinner: ['Tolcarne Drive','Joel Street','Pinner Road','Rickmansworth Road','Ducks Hill Road','Bury Street','Eastcote Road','Field End Road','Marsh Road','Elm Park Road','Pinner Hill Road','High Street Pinner','Cuckoo Hill Road','Cannon Lane','Waxwell Lane'],
  Hendon: ['Aviation Drive','Beaufort Square','Caversham Road','Aerodrome Road','Colindale Avenue','Edgware Road','W Hendon Broadway','Watford Way','N Circular Road','Nether Street','Holders Hill Circus','Parson Street','Greyhound Hill','Station Road','Brent Street'],
  'Mill Hill': ['Bunns Lane','Flower Lane','The Broadway','Mill Hill Circus','Watford Way A41','Edgware Way','Spur Road','Stonegrove','Burnt Oak Broadway','Edgware Road','W Hendon Broadway','North Circular Road A406','Brent Cross Flyover','Hendon Way','Barnet Bypass'],
  Watford: ['Otterspool Way','St Albans Road A412','Rickmansworth Road A4125','Hempstead Road','Langley Road','Cassiobury Park','High Street Watford','Queens Road','King Street','Lower High Street','Bushey Mill Lane','North Western Avenue','Beechen Grove','Clarendon Road','The Parade'],
  Borehamwood: ['Stirling Way','Shenley Road','Brook Road','Elstree Way','Leeming Road','Manor Way','Aycliffe Road','Furzehill Road','Station Road','Theobald Street','Hartforde Road','Banks Road','Warwick Road','Cameron Close','Cowley Hill'],
  Greenford: ['Horsenden Lane North','Robin Hood Way','Whitton Avenue East','Greenford Road','Western Avenue A40','Argyle Road','Lady Margaret Road','Windmill Lane','Ruislip Road','Oldfield Lane North','Ferrymead Avenue','Rockware Avenue','Springfield Road','Costons Lane','Braund Avenue'],
  Yeading: ['Cygnet Way','Willow Tree Lane','Hayes Bypass A312','Kingshill Avenue','Yeading Lane','Rayners Lane','Granville Road','The Parkway','Charville Lane','Uxbridge Road','Colham Avenue','Coldharbour Lane','Church Road Hayes','North Hyde Road','Springfield Road']
};

function getFallbackStreetList() {
  return ['High Street','Church Road','Station Road','Park Avenue','Victoria Road','Manor Drive','Bridge Street','Market Place','Castle Road','Mill Lane','Kings Road','Green Lane','School Lane','The Avenue','London Road'];
}

export function getRouteWaypoints(centre, routeNum, isAdi) {
  const safeRouteNum = Math.max(1, Number.parseInt(routeNum, 10) || 1);
  const { lat, lng } = centre;
  const offset = 0.008 + safeRouteNum * 0.002;
  const adiOffset = isAdi ? 0.005 : 0;
  const patterns = [
    [{ lat: lat + offset, lng }, { lat: lat + offset * 0.8, lng: lng + offset }, { lat, lng: lng + offset * 1.2 }, { lat: lat - offset * 0.5, lng: lng + offset * 0.8 }, { lat: lat - offset * 0.3, lng }],
    [{ lat, lng: lng + offset }, { lat: lat - offset * 0.8, lng: lng + offset * 0.9 }, { lat: lat - offset, lng }, { lat: lat - offset * 0.5, lng: lng - offset * 0.5 }, { lat, lng: lng - offset * 0.3 }],
    [{ lat: lat - offset, lng }, { lat: lat - offset * 0.9, lng: lng + offset * 0.8 }, { lat: lat - offset * 0.3, lng: lng + offset }, { lat: lat + offset * 0.3, lng: lng + offset * 0.5 }, { lat: lat + offset * 0.2, lng }],
    [{ lat, lng: lng - offset }, { lat: lat + offset * 0.7, lng: lng - offset * 0.8 }, { lat: lat + offset, lng }, { lat: lat + offset * 0.4, lng: lng + offset * 0.4 }, { lat, lng: lng + offset * 0.2 }],
    [{ lat: lat + offset + adiOffset, lng: lng + offset * 0.5 }, { lat: lat + offset * 0.5, lng: lng + offset + adiOffset }, { lat: lat - offset * 0.3, lng: lng + offset + adiOffset }, { lat: lat - offset - adiOffset, lng }, { lat: lat - offset * 0.5, lng: lng - offset * 0.5 }]
  ];
  const selectedPattern = patterns[(safeRouteNum - 1) % patterns.length] || patterns[0];
  return [{ lat, lng }, ...selectedPattern, { lat, lng }];
}

export function getRouteSteps(centre, routeNum, isAdi) {
  const streets = centreStreets[centre.name] || getFallbackStreetList();
  const numSteps = isAdi ? 12 : 10;
  const steps = [`🏢 Start at ${centre.name} Test Centre - exit onto ${streets[0]}`];
  const dirActions = ['Turn left onto','Turn right onto','Continue straight onto','Bear left onto','At the roundabout take exit 2 onto','At the mini-roundabout turn left onto','At the traffic lights turn right onto','Turn left at the junction onto','Bear right and continue onto','Follow the road onto'];
  for (let i = 1; i < numSteps - 1; i += 1) {
    const street = streets[i % streets.length];
    const action = dirActions[i % dirActions.length];
    const distanceMeters = [200, 300, 400, 500, 600, 800, 1000][i % 7];
    steps.push(`${action} ${street} (${distanceMeters}m)`);
  }
  steps.push(`🏁 Return to ${centre.name} Test Centre`);
  return steps;
}

export function getRouteBundle(centreId, routeNum, isAdi) {
  const centre = findCentreById(centreId);
  if (!centre) return null;
  return {
    centre,
    routeNum: Number.parseInt(routeNum, 10) || 1,
    isAdi: Boolean(isAdi),
    routeName: `${isAdi ? 'ADI Route' : 'Standard Route'} ${routeNum}`,
    labels: getRouteLabels(centre, isAdi),
    steps: getRouteSteps(centre, routeNum, isAdi),
    waypoints: getRouteWaypoints(centre, routeNum, isAdi),
    generatedAt: new Date().toISOString()
  };
}
