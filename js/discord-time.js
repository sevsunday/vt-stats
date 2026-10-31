/* Discord Time. A local date and time become a Discord <t:unix:style>
   code. The visitor's browser locale formats the confirmation and the
   previews. City clocks use a fixed locale per place so Berlin stays
   24-hour and Sydney stays day/month. Display-only. */
(function () {
  'use strict';

  var CITIES = [
    {
      zone: 'America/Los_Angeles',
      also: ['America/Vancouver'],
      city: 'Los Angeles \u00b7 Vancouver',
      locale: 'en-US',
      hour12: true
    },
    {
      zone: 'America/Chicago',
      also: [],
      city: 'Chicago',
      locale: 'en-US',
      hour12: true
    },
    {
      zone: 'America/New_York',
      also: ['America/Toronto'],
      city: 'New York \u00b7 Toronto',
      locale: 'en-US',
      hour12: true
    },
    {
      zone: 'Europe/Berlin',
      also: [],
      city: 'Berlin',
      locale: 'de-DE',
      hour12: false
    },
    {
      zone: 'Australia/Sydney',
      also: [],
      city: 'Sydney',
      locale: 'en-AU',
      hour12: true
    }
  ];

  var PLACE = {
    'America/Los_Angeles': 'Los Angeles',
    'America/Vancouver': 'Vancouver',
    'America/Chicago': 'Chicago',
    'America/New_York': 'New York',
    'America/Toronto': 'Toronto',
    'Europe/Berlin': 'Berlin',
    'Australia/Sydney': 'Sydney'
  };

  var dateEl = document.getElementById('vt-time-date');
  var clockEl = document.getElementById('vt-time-clock');
  var confirmEl = document.getElementById('vt-time-confirm');
  var nowBtn = document.getElementById('vt-time-now');
  var clocks = document.querySelectorAll('.vt-discord-elsewhere .vt-world-clock');
  var codeBtns = document.querySelectorAll('[data-vt-style]');

  if (!dateEl || !clockEl || !confirmEl || !codeBtns.length) return;

  var zone = viewerZone();
  var copyTimer = 0;

  function viewerZone() {
    try {
      var name = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      Intl.DateTimeFormat('en-US', { timeZone: name });
      return name;
    } catch (e) {
      return 'UTC';
    }
  }

  function partMap(date, timeZone) {
    var dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    var out = {};
    dtf.formatToParts(date).forEach(function (p) {
      if (p.type !== 'literal') out[p.type] = p.value;
    });
    if (out.hour === '24') out.hour = '00';
    return out;
  }

  function offsetMs(utcMs, timeZone) {
    var parts = partMap(new Date(utcMs), timeZone);
    var asUTC = Date.UTC(
      +parts.year, +parts.month - 1, +parts.day,
      +parts.hour, +parts.minute, +parts.second
    );
    return asUTC - utcMs;
  }

  /* Wall-clock fields are the numbers the visitor picked, interpreted
     in their own zone. Pretend those numbers are UTC, then subtract
     the zone offset, and repeat once so a daylight-saving boundary
     does not land an hour off. */
  function unixFromWall(year, month, day, hour, minute, timeZone) {
    var utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
    var off1 = offsetMs(utcGuess, timeZone);
    var corrected = utcGuess - off1;
    var off2 = offsetMs(corrected, timeZone);
    if (off2 !== off1) corrected = utcGuess - off2;
    return Math.floor(corrected / 1000);
  }

  function wallFromUnix(unix, timeZone) {
    var parts = partMap(new Date(unix * 1000), timeZone);
    return {
      date: parts.year + '-' + parts.month + '-' + parts.day,
      time: parts.hour + ':' + parts.minute
    };
  }

  function placeName(timeZone) {
    if (PLACE[timeZone]) return PLACE[timeZone];
    if (!timeZone || timeZone === 'UTC') return 'UTC';
    var bits = String(timeZone).split('/');
    var last = (bits[bits.length - 1] || '').replace(/_/g, ' ').trim();
    return last || 'UTC';
  }

  function readUnix() {
    var date = dateEl.value;
    var time = (clockEl.value || '').slice(0, 5);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
    var y = +date.slice(0, 4);
    var m = +date.slice(5, 7);
    var d = +date.slice(8, 10);
    var hh = +time.slice(0, 2);
    var mm = +time.slice(3, 5);
    if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
    return unixFromWall(y, m, d, hh, mm, zone);
  }

  function sentence(date) {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(date);
  }

  function stylePreview(date, style) {
    if (style === 't') {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: zone,
        hour: 'numeric',
        minute: '2-digit'
      }).format(date);
    }
    if (style === 'D') {
      return new Intl.DateTimeFormat(undefined, {
        timeZone: zone,
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      }).format(date);
    }
    if (style === 'R') return relativeLabel(Math.floor(date.getTime() / 1000), Math.floor(Date.now() / 1000));
    return sentence(date);
  }

  function relativeLabel(unix, nowSec) {
    var delta = unix - nowSec;
    var abs = Math.abs(delta);
    var rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' });
    var units = [
      ['year', 31536000],
      ['month', 2592000],
      ['week', 604800],
      ['day', 86400],
      ['hour', 3600],
      ['minute', 60],
      ['second', 1]
    ];
    var i;
    for (i = 0; i < units.length; i++) {
      if (abs >= units[i][1] || units[i][0] === 'second') {
        return rtf.format(Math.round(delta / units[i][1]), units[i][0]);
      }
    }
    return rtf.format(0, 'second');
  }

  function codeFor(unix, style) {
    if (!style || style === 'F') return '<t:' + unix + ':F>';
    return '<t:' + unix + ':' + style + '>';
  }

  function utcOffsetLabel(timeZone, date) {
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone,
        timeZoneName: 'shortOffset'
      }).formatToParts(date);
      var raw = '';
      var i;
      for (i = 0; i < parts.length; i++) {
        if (parts[i].type === 'timeZoneName') raw = parts[i].value;
      }
      raw = String(raw || 'GMT').replace(/^GMT/i, '').trim();
      if (!raw) return 'UTC';
      var m = /^([+-])(\d{1,2})(?::(\d{2}))?$/.exec(raw);
      if (!m) return 'UTC';
      var sign = m[1] === '-' ? '\u2212' : '+';
      var mins = m[3] && m[3] !== '00' ? ':' + m[3] : '';
      return 'UTC' + sign + String(Number(m[2])) + mins;
    } catch (e) {
      return '';
    }
  }

  function cityWhen(date, city) {
    return new Intl.DateTimeFormat(city.locale, {
      timeZone: city.zone,
      day: 'numeric',
      month: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: city.hour12
    }).format(date);
  }

  function isYou(city) {
    if (zone === city.zone) return true;
    return city.also.indexOf(zone) !== -1;
  }

  function paintClocks(date) {
    var i;
    for (i = 0; i < clocks.length; i++) {
      var pill = clocks[i];
      var city = CITIES[i];
      if (!city) continue;
      var when = date ? cityWhen(date, city) : '\u2014';
      var you = date && isYou(city);
      pill.classList.toggle('vt-world-clock--local', !!you);
      var timeEl = pill.querySelector('time');
      var offsetEl = pill.querySelector('.vt-world-clock-offset');
      if (timeEl) {
        timeEl.textContent = when;
        if (date) timeEl.setAttribute('datetime', date.toISOString());
        else timeEl.removeAttribute('datetime');
      }
      if (offsetEl) offsetEl.textContent = date ? utcOffsetLabel(city.zone, date) : '';
      var label = when + ', ' + city.city;
      if (you) label = 'Your timezone, ' + label;
      pill.setAttribute('title', label);
      pill.setAttribute('aria-label', label);
    }
  }

  function setCopyLabel(button, text) {
    var label = button.querySelector('[data-vt-copy-label]');
    if (label) label.textContent = text;
  }

  function writeUrl(unix) {
    try {
      var url = new URL(window.location.href);
      url.searchParams.set('t', String(unix));
      var next = url.pathname + url.search;
      if (next !== window.location.pathname + window.location.search) {
        history.replaceState(null, '', next);
      }
    } catch (e) { /* ignore */ }
  }

  function render() {
    var unix = readUnix();
    if (unix == null) {
      confirmEl.textContent = 'Pick a date and time.';
      codeBtns.forEach(function (btn) { btn.disabled = true; });
      paintClocks(null);
      return;
    }
    var date = new Date(unix * 1000);
    confirmEl.textContent = sentence(date) + ' \u00b7 your time (' + placeName(zone) + ')';
    codeBtns.forEach(function (btn) {
      var style = btn.getAttribute('data-vt-style');
      btn.disabled = false;
      btn.setAttribute('title', codeFor(unix, style));
      setCopyLabel(btn, stylePreview(date, style));
    });
    paintClocks(date);
    writeUrl(unix);
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      try {
        var ok = document.execCommand('copy');
        document.body.removeChild(area);
        if (ok) resolve();
        else reject(new Error('copy'));
      } catch (e) {
        document.body.removeChild(area);
        reject(e);
      }
    });
  }

  function flash(button, idle) {
    window.clearTimeout(copyTimer);
    setCopyLabel(button, 'Copied');
    copyTimer = window.setTimeout(function () {
      setCopyLabel(button, idle);
      render();
    }, 1400);
  }

  codeBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var unix = readUnix();
      if (unix == null) return;
      var style = btn.getAttribute('data-vt-style');
      var idle = btn.querySelector('[data-vt-copy-label]');
      var idleText = idle ? idle.textContent : '';
      copyText(codeFor(unix, style)).then(function () {
        flash(btn, idleText);
      }, function () { /* leave the label */ });
    });
  });

  function applyWall(wall) {
    dateEl.value = wall.date;
    clockEl.value = wall.time;
    render();
  }

  nowBtn.addEventListener('click', function () {
    applyWall(wallFromUnix(Math.floor(Date.now() / 1000), zone));
  });

  dateEl.addEventListener('input', render);
  clockEl.addEventListener('input', render);

  var params = new URLSearchParams(window.location.search);
  var fromUrl = params.get('t');
  var unix = fromUrl && /^\d{1,12}$/.test(fromUrl) ? Number(fromUrl) : NaN;
  if (unix >= 0 && unix < 4102444800) applyWall(wallFromUnix(unix, zone));
  else applyWall(wallFromUnix(Math.floor(Date.now() / 1000), zone));

  window.setInterval(function () {
    var current = readUnix();
    if (current == null) return;
    codeBtns.forEach(function (btn) {
      if (btn.getAttribute('data-vt-style') !== 'R') return;
      if (btn.querySelector('[data-vt-copy-label]').textContent === 'Copied') return;
      setCopyLabel(btn, relativeLabel(current, Math.floor(Date.now() / 1000)));
    });
  }, 1000);
})();
