// Device location: dot with accuracy circle, explicit states (locating, current, stale, denied,
// unavailable, timeout). Position stays on this device; nothing is sent anywhere.
import {el, toast} from './dom.js';
import {ageText} from '../lib/time.js';
import {fmtDistance} from '../lib/units.js';

const STALE_MS = 60000;
const circle = (lon, lat, r, n = 48) => {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    pts.push([lon + (r / (111320 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a), lat + (r / 110540) * Math.sin(a)]);
  }
  return {type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [pts]}};
};

export function initLocate(map) {
  const btn = document.getElementById('btn-locate');
  const status = document.getElementById('locstatus');
  let watch = null; let last = null; let marker = null; let follow = true;
  const show = (text, bad = false) => { status.hidden = !text; status.textContent = text; status.classList.toggle('bad', bad); };
  const ensureLayers = () => {
    if (map.getSource('me-acc')) return;
    map.addSource('me-acc', {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
    map.addLayer({id: 'me-acc', type: 'fill', source: 'me-acc', paint: {'fill-color': '#1e88e5', 'fill-opacity': 0.15, 'fill-outline-color': '#1e88e5'}}, 'anchor-overlay');
  };
  function render() {
    if (!last) return;
    const age = Date.now() - last.timestamp;
    const stale = age > STALE_MS;
    show(`${stale ? 'Last known location' : 'Location'} ±${fmtDistance(last.coords.accuracy)} · ${ageText(last.timestamp)}`, stale);
    marker?.getElement().style.setProperty('opacity', stale ? '0.5' : '1');
  }
  function onPos(p) {
    last = p;
    const {longitude: lon, latitude: lat, accuracy} = p.coords;
    ensureLayers();
    map.getSource('me-acc').setData(circle(lon, lat, accuracy));
    if (!marker) marker = new maplibregl.Marker({element: el('div', {style: 'width:18px;height:18px;border-radius:50%;background:#1e88e5;border:3px solid #fff;box-shadow:0 0 4px #0008', 'aria-hidden': 'true'})});
    marker.setLngLat([lon, lat]).addTo(map);
    if (follow) { map.easeTo({center: [lon, lat], zoom: Math.max(map.getZoom(), 13)}); follow = false; }
    btn.classList.remove('busy');
    btn.setAttribute('aria-pressed', 'true');
    render();
  }
  function onErr(e) {
    btn.classList.remove('busy');
    const msg = e.code === 1 ? 'Location permission denied. Enable it in browser settings to see your position.'
      : e.code === 3 ? 'Location timed out. Move to open sky and try again.' : 'Location unavailable on this device right now.';
    show(last ? `${msg} Showing last known position (${ageText(last.timestamp)}).` : msg, true);
    if (e.code === 1) stop();
  }
  function stop() {
    if (watch !== null) navigator.geolocation.clearWatch(watch);
    watch = null;
    btn.setAttribute('aria-pressed', 'false');
  }
  btn.addEventListener('click', () => {
    if (!('geolocation' in navigator)) { show('This browser has no location support.', true); return; }
    if (watch !== null && last) { map.easeTo({center: [last.coords.longitude, last.coords.latitude]}); return; }
    follow = true;
    btn.classList.add('busy');
    show('Finding your location…');
    watch = navigator.geolocation.watchPosition(onPos, onErr, {enableHighAccuracy: true, maximumAge: 10000, timeout: 20000});
  });
  setInterval(render, 15000);
  return {stop, get last() { return last; }, toast};
}
