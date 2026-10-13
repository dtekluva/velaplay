// Load test for the Giantwood world room: simulated guests join far from spawn, walk about 10x a second,
// and an observer measures update rate and how long its own moves take to come back through the server.
const dns = require('dns');
const HOST = '46-101-63-217.sslip.io', IP = '46.101.63.217';
const realLookup = dns.lookup;
dns.lookup = (h, o, cb) => { if (typeof o === 'function') { cb = o; o = {}; } if (h === HOST) return o && o.all ? cb(null, [{ address: IP, family: 4 }]) : cb(null, IP, 4); return realLookup(h, o, cb); };
const { Client } = require('colyseus.js');
const client = new Client('wss://' + HOST);
const STEPS = (process.argv[2] || '20,40,60,80').split(',').map(Number), HOLD = +(process.argv[3] || 40);
const AREA = { x: 210, z: -260 };
const bots = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function addBot(i) {
  const x = AREA.x + (Math.random() - .5) * 60, z = AREA.z + (Math.random() - .5) * 60;
  const room = await client.joinOrCreate('world', { name: 'loadbot' + i, x, y: 5, z });
  const b = { room, x, z, a: Math.random() * 6.28, t: null };
  b.t = setInterval(() => { b.a += (Math.random() - .5) * .6; b.x += Math.cos(b.a) * .5; b.z += Math.sin(b.a) * .5;
    if (Math.hypot(b.x - AREA.x, b.z - AREA.z) > 40) b.a += Math.PI;
    room.send('move', { x: b.x, y: 5, z: b.z, ry: b.a, anim: 'run', veh: '' }); }, 100);
  room.onMessage('*', () => {});
  bots.push(b); return b;
}
(async () => {
  // the observer: counts state patches, and times its own moves round trip
  const obs = await client.joinOrCreate('world', { name: 'loadwatch', x: AREA.x, y: 5, z: AREA.z });
  obs.onMessage('*', () => {});
  let patches = 0, lat = [], probe = null, px = AREA.x;
  obs.onStateChange(st => { patches++; const me = st.players.get(obs.sessionId); if (probe && me && Math.abs(me.x - probe.x) < .001) { lat.push(Date.now() - probe.t); probe = null; } });
  setInterval(() => { px = AREA.x + Math.random() * 5; probe = { x: px, t: Date.now() }; obs.send('move', { x: px, y: 5, z: AREA.z, ry: 0, anim: 'idle', veh: '' }); }, 500);
  console.log('step,bots,players_in_room,patches_per_s,echo_ms_avg,echo_ms_p95');
  for (const n of STEPS) {
    const want = n - bots.length;
    for (let i = 0; i < want; i++) { try { await addBot(bots.length); } catch (e) { console.log('join failed at', bots.length, e.message); break; } await sleep(60); }
    await sleep(5000); patches = 0; lat = [];
    const t0 = Date.now(); await sleep(HOLD * 1000);
    const s = (Date.now() - t0) / 1000, L = lat.slice().sort((a, b) => a - b);
    const rooms = new Set(bots.map(b => b.room.roomId)).size;
    console.log([n, bots.length, obs.state.players.size, (patches / s).toFixed(1), L.length ? (L.reduce((a, b) => a + b, 0) / L.length).toFixed(0) : '-', L.length ? L[Math.floor(L.length * .95)] : '-', 'rooms=' + rooms].join(','));
  }
  for (const b of bots) { clearInterval(b.t); try { await b.room.leave(); } catch (e) {} }
  await obs.leave(); console.log('done'); process.exit(0);
})().catch(e => { console.error('ERR', e && e.message || e); process.exit(1); });
