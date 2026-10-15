/* Live world-clock bar under the dashboard navbar.
   Display-only. index.html only. */
(function () {
  var root = document.querySelector('.vt-world-clocks');
  if (!root) return;

  var pills = root.querySelectorAll('.vt-world-clock');
  if (!pills.length) return;

  function viewerTimeZone() {
    try {
      var zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      Intl.DateTimeFormat('en-US', { timeZone: zone });
      return zone;
    } catch (e) {
      return 'UTC';
    }
  }

  function placeLocal() {
    var zone = viewerTimeZone();
    var extra = root.querySelector('[data-zone="local"]');
    var match = null;
    var i;
    for (i = 0; i < pills.length; i++) {
      pills[i].classList.remove('vt-world-clock--local');
      if (pills[i].getAttribute('data-zone') === zone) match = pills[i];
    }
    if (match) {
      match.classList.add('vt-world-clock--local');
      if (extra) extra.hidden = true;
      root.classList.remove('vt-world-clocks--extra');
      return;
    }
    if (!extra) return;
    extra.hidden = false;
    extra.classList.add('vt-world-clock--local');
    root.classList.add('vt-world-clocks--extra');
  }

  function cityFromZone(zone) {
    if (!zone || zone === 'UTC') return 'Local';
    var parts = String(zone).split('/');
    var last = (parts[parts.length - 1] || '').replace(/_/g, ' ').trim();
    return last || 'Local';
  }

  function utcOffsetLabel(timeZone, date) {
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone || 'UTC',
        timeZoneName: 'shortOffset',
      }).formatToParts(date);
      var raw = ((parts.find(function (p) { return p.type === 'timeZoneName'; }) || {}).value || 'GMT');
      raw = raw.replace(/^GMT/i, '').trim();
      if (!raw) return 'UTC';
      var m = /^([+-])(\d{1,2})(?::(\d{2}))?$/.exec(raw);
      if (!m) return 'UTC';
      var sign = m[1] === '-' ? '\u2212' : '+';
      var hours = String(Number(m[2]));
      var mins = m[3] && m[3] !== '00' ? ':' + m[3] : '';
      return 'UTC' + sign + hours + mins;
    } catch (e) {
      return '';
    }
  }

  function paint() {
    var now = new Date();
    for (var i = 0; i < pills.length; i++) {
      var pill = pills[i];
      var zoneAttr = pill.getAttribute('data-zone') || 'UTC';
      var isLocal = zoneAttr === 'local';
      var zone = isLocal ? viewerTimeZone() : zoneAttr;
      var city = isLocal ? cityFromZone(zone) : (pill.getAttribute('data-city') || zone);
      if (isLocal) {
        var cityEl = pill.querySelector('.vt-world-clock-city');
        if (cityEl) cityEl.textContent = city;
      }
      var time = '\u2014';
      var weekday = '';
      try {
        time = new Intl.DateTimeFormat('en-US', {
          timeZone: zone,
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }).format(now);
        weekday = new Intl.DateTimeFormat('en-US', {
          timeZone: zone,
          weekday: 'long',
        }).format(now);
      } catch (e) {
        time = '\u2014';
      }
      var offset = utcOffsetLabel(zone, now);
      var timeEl = pill.querySelector('time');
      var offsetEl = pill.querySelector('.vt-world-clock-offset');
      if (timeEl) {
        timeEl.textContent = time;
        timeEl.setAttribute('datetime', now.toISOString());
      }
      if (offsetEl) offsetEl.textContent = offset;
      var label = weekday ? (weekday + ', ' + time + ', ' + city) : (time + ', ' + city);
      if (offset) label += ', ' + offset;
      if (pill.classList.contains('vt-world-clock--local')) label = 'Your timezone, ' + label;
      pill.setAttribute('title', label);
      pill.setAttribute('aria-label', label);
    }
  }

  function tick() {
    paint();
    var delay = 1000 - (Date.now() % 1000);
    window.setTimeout(tick, delay);
  }

  placeLocal();
  tick();
})();
