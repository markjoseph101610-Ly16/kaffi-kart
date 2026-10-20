/* Hello Kaffi realtime shim.
   Vercel cannot hold WebSocket connections open, so this file replaces window.WebSocket with a tiny
   look-alike that polls /api/sync and emits the SAME messages the server used to push
   ({type:'menu'}, {type:'order'}, {type:'riders'}). script.js / gcash.js / pos/script.js are unchanged.
   Must be loaded BEFORE script.js and gcash.js. */
(function () {
  var POLL_MS = 3000;
  var API = location.port === '5500' ? 'http://localhost:3000' : '';   // VS Code Live Server -> Node server
  var FINAL = ['Completed', 'Cancelled'];

  function PollSocket(url) {
    var self = this, token = '';
    try { token = new URL(url, location.href).searchParams.get('token') || ''; } catch (e) {}
    this.readyState = 0; this.url = url;
    this._l = { open: [], message: [], close: [], error: [] };
    var rev = -1, known = null, lastMenu = '', lastRiders = '', timer = null, closed = false, busy = false;

    function emit(type, ev) {
      if (typeof self['on' + type] === 'function') { try { self['on' + type](ev); } catch (e) { console.error(e); } }
      self._l[type].slice().forEach(function (f) { try { f.call(self, ev); } catch (e) { console.error(e); } });
    }
    function msg(obj) { emit('message', { type: 'message', data: JSON.stringify(obj), target: self }); }
    function shut(code) { if (closed) return; closed = true; clearTimeout(timer); self.readyState = 3; emit('close', { type: 'close', code: code || 1006, target: self }); }

    function apply(d) {
      var m = JSON.stringify(d.menu || []);
      if (m !== lastMenu) { lastMenu = m; msg({ type: 'menu', menu: d.menu }); }
      if (d.riders) { var r = JSON.stringify(d.riders); if (r !== lastRiders) { lastRiders = r; msg({ type: 'riders', riders: d.riders }); } }
      var first = known === null; if (first) known = {};
      (d.orders || []).forEach(function (o) {
        var j = JSON.stringify(o), old = known[o.id];
        known[o.id] = j;
        if (first) return;                                  // orders already on screen came from the normal REST load
        if (old === undefined) msg({ type: 'order', order: o, isNew: FINAL.indexOf(o.status) < 0 });
        else if (old !== j) msg({ type: 'order', order: o });
      });
    }
    function tick() {
      if (closed) return;
      if (document.hidden || busy) { timer = setTimeout(tick, POLL_MS); return; }
      busy = true;
      fetch(API + '/api/sync?rev=' + encodeURIComponent(rev), { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' })
        .then(function (r) {
          if (r.status === 401) { shut(4001); return null; }          // same as the old ws.close(4001, 'unauthorized')
          if (!r.ok) throw new Error('sync ' + r.status);
          return r.json();
        })
        .then(function (d) {
          if (!d || closed) return;
          if (self.readyState === 0) { self.readyState = 1; emit('open', { type: 'open', target: self }); }
          if (!d.same) { rev = d.rev; apply(d); }
          busy = false; timer = setTimeout(tick, POLL_MS);
        })
        .catch(function () { busy = false; if (self.readyState === 1) { shut(1006); } else { timer = setTimeout(tick, POLL_MS * 2); } });
    }
    document.addEventListener('visibilitychange', function () { if (!document.hidden && !closed) { clearTimeout(timer); tick(); } });
    setTimeout(tick, 0);
    this.close = function () { shut(1000); };
    this.send = function () {};
  }
  PollSocket.prototype.addEventListener = function (t, f) { if (this._l[t]) this._l[t].push(f); };
  PollSocket.prototype.removeEventListener = function (t, f) { if (this._l[t]) this._l[t] = this._l[t].filter(function (x) { return x !== f; }); };
  PollSocket.CONNECTING = 0; PollSocket.OPEN = 1; PollSocket.CLOSING = 2; PollSocket.CLOSED = 3;
  window.WebSocket = PollSocket;
})();
