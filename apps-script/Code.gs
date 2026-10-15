/**
 * Chromebook Cart Event Checkout — Google Apps Script backend.
 *
 * Runs under YOUR Google account and writes reservations to your calendar.
 * The GitHub Pages form sends requests here; nothing secret lives on GitHub.
 *
 * Setup: see README.md, Step 2. Settings are in Settings.gs.
 */

// Settings (CALENDAR_ID, CARTS, NOTIFY_EMAIL, ...) live in Settings.gs.

const TITLE_PREFIX = '[Chromebook] ';
const CART_SEP = ' + ';
const NAME_SEP = ' — ';

/** Book one or more carts for one or more dates. Called by the form with a JSON body. */
function doPost(e) {
  return safely_(function () { return book_(e); });
}

/** List bookings in a date range so the form can show a calendar: ?from=YYYY-MM-DD&to=YYYY-MM-DD (or ?date=YYYY-MM-DD) */
function doGet(e) {
  return safely_(function () { return list_(e); });
}

/** Always answer with JSON. An uncaught error would send an HTML page the form can't read. */
function safely_(fn) {
  try {
    return fn();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return json_({
      ok: false,
      error: 'The calendar service had a temporary problem. Please try again in a moment. (' + (err && err.message ? err.message : err) + ')',
    });
  }
}

/** Retry Google's temporary errors ("too many requests", "server error", ...) with backoff. */
function retry_(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (attempt >= 4) throw err;
      console.warn('Retrying after: ' + (err && err.message ? err.message : err));
      Utilities.sleep(1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 500));
    }
  }
}

function book_(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Invalid request.' });
  }

  const tz = Session.getScriptTimeZone();
  const error = validate_(req, tz);
  if (error) return json_({ ok: false, error: error });

  // Lock so two people can't grab the same cart at the same moment.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return json_({ ok: false, error: 'Lots of people are booking right now. Please try again in a moment.' });
  }
  try {
    const cal = retry_(function () { return CalendarApp.getCalendarById(CALENDAR_ID); });

    // Check every date before booking any, so a request is all-or-nothing.
    const conflicts = [];
    req.sessions.forEach(function (s) {
      retry_(function () { return bookingsBetween_(cal, s.startDate, s.endDate); }).forEach(function (b) {
        const taken = b.carts.filter(function (c) { return req.carts.indexOf(c) !== -1; });
        if (taken.length) {
          conflicts.push(taken.join(' and ') + ' on ' + Utilities.formatDate(b.start, tz, 'EEE MMM d') + ', ' +
            fmtTime_(b.start, tz) + '–' + fmtTime_(b.end, tz) + ' (' + b.teacher + ')');
        }
      });
    });
    if (conflicts.length) {
      return json_({ ok: false, error: 'Already booked: ' + conflicts.join('; ') + '. Please pick another cart or time.' });
    }

    const who = req.contactName ? req.name + ' (for ' + req.contactName + ')' : req.name;
    const title = TITLE_PREFIX + req.carts.join(CART_SEP) + NAME_SEP + who;
    const total = req.carts.reduce(function (n, c) { return n + CARTS[c]; }, 0);
    const days = req.sessions.slice().sort(function (a, b) { return a.startDate - b.startDate; });
    const description = [
      'Chromebooks: ' + total + ' (' + req.carts.map(function (c) { return c + ': ' + CARTS[c]; }).join(', ') + ')',
      'Location: ' + req.location,
      'Requested by: ' + req.name + ' <' + req.email + '>',
      req.contactName ? 'Contact person: ' + req.contactName + (req.contactInfo ? ' (' + req.contactInfo + ')' : '') : '',
      'Notes: ' + (req.notes || '(none)'),
      days.length > 1 ? '\nAll dates in this request:\n' + days.map(function (s) {
        return '• ' + Utilities.formatDate(s.startDate, tz, 'EEE, MMM d') + ': carts arrive ' + fmtTime_(s.startDate, tz) +
          ', event ends ' + fmtTime_(s.endDate, tz);
      }).join('\n') : '',
    ].filter(Boolean).join('\n') + '\n\nBooked via the Chromebook Cart Event Checkout form.';

    // Calendar sends the invites itself, so this works without Gmail (e.g. when mail is on Microsoft 365).
    const guests = (INVITE_REQUESTER ? [req.email] : []).concat(notifyList_())
      .filter(function (g, i, all) { return all.map(lower_).indexOf(lower_(g)) === i; });
    const options = { description: description, location: req.location };
    if (guests.length) {
      options.guests = guests.join(',');
      options.sendInvites = true;
    }
    // All days or none: if Google fails partway, remove the days already created.
    const created = [];
    try {
      req.sessions.forEach(function (s) {
        created.push(retry_(function () { return cal.createEvent(title, s.startDate, s.endDate, options); }));
      });
    } catch (err) {
      created.forEach(function (ev) {
        try { ev.deleteEvent(); } catch (e2) { console.error('Rollback failed: ' + e2); }
      });
      throw err;
    }
    bumpVersion_();
  } finally {
    lock.releaseLock();
  }

  return json_({ ok: true });
}

function list_(e) {
  const p = (e && e.parameter) || {};
  const from = p.from || p.date;
  const to = p.to || p.date;
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from || '') || !re.test(to || '')) return json_({ ok: false, error: 'Missing date range.' });

  const tz = Session.getScriptTimeZone();
  const start = Utilities.parseDate(from + ' 00:00', tz, 'yyyy-MM-dd HH:mm');
  const end = new Date(Utilities.parseDate(to + ' 00:00', tz, 'yyyy-MM-dd HH:mm').getTime() + 24 * 60 * 60 * 1000);
  if (end <= start || end - start > 62 * 24 * 60 * 60 * 1000) return json_({ ok: false, error: 'Range too large.' });

  // Cache each range for a minute so many people loading the calendar don't hit Calendar's limits.
  // A new booking changes the version, so it shows up right away. Edits made directly in
  // Google Calendar can take up to a minute to appear.
  const cache = CacheService.getScriptCache();
  const key = ['bookings', version_(), from, to].join(':');
  const cached = cache.get(key);
  if (cached) return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);

  const cal = retry_(function () { return CalendarApp.getCalendarById(CALENDAR_ID); });
  const bookings = retry_(function () { return bookingsBetween_(cal, start, end); }).map(function (b) {
    return {
      date: Utilities.formatDate(b.start, tz, 'yyyy-MM-dd'),
      start: Utilities.formatDate(b.start, tz, 'HH:mm'),
      end: Utilities.formatDate(b.end, tz, 'HH:mm'),
      carts: b.carts,
      teacher: b.teacher,
      location: b.location,
    };
  });
  const text = JSON.stringify({ ok: true, bookings: bookings });
  try { cache.put(key, text, 60); } catch (err) { console.warn('Cache put failed: ' + err); }
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

function version_() {
  return PropertiesService.getScriptProperties().getProperty('BOOKINGS_VERSION') || '0';
}

function bumpVersion_() {
  PropertiesService.getScriptProperties().setProperty('BOOKINGS_VERSION', String(Date.now()));
}

function bookingsBetween_(cal, start, end) {
  return cal.getEvents(start, end)
    .filter(function (ev) { return ev.getTitle().indexOf(TITLE_PREFIX) === 0; })
    .map(function (ev) {
      const parts = ev.getTitle().slice(TITLE_PREFIX.length).split(NAME_SEP);
      return {
        carts: parts[0].split(CART_SEP),
        teacher: parts.slice(1).join(NAME_SEP),
        location: ev.getLocation(),
        start: ev.getStartTime(),
        end: ev.getEndTime(),
      };
    });
}

/** Validates the request and adds parsed start/end Dates to each session. Returns an error message or null. */
function validate_(r, tz) {
  if (!r || typeof r !== 'object') return 'Invalid request.';
  if (r.website) return 'Invalid request.'; // honeypot field filled in by bots
  const required = { name: 'your name', email: 'your email', location: 'the event location' };
  for (const k in required) {
    if (!r[k] || String(r[k]).trim() === '') return 'Please enter ' + required[k] + '.';
    r[k] = String(r[k]).trim().slice(0, 200);
  }
  r.notes = r.notes ? String(r.notes).slice(0, 1000) : '';
  r.contactName = r.contactName ? String(r.contactName).trim().slice(0, 200) : '';
  r.contactInfo = r.contactName && r.contactInfo ? String(r.contactInfo).trim().slice(0, 200) : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)) return 'Please enter a valid email.';
  if (ALLOWED_EMAIL_DOMAIN && !r.email.toLowerCase().endsWith(ALLOWED_EMAIL_DOMAIN.toLowerCase())) {
    return 'Please use your ' + ALLOWED_EMAIL_DOMAIN + ' email.';
  }

  if (!Array.isArray(r.carts) || !r.carts.length) return 'Please choose at least one cart.';
  const cartNames = Object.keys(CARTS);
  const unknown = r.carts.filter(function (c) { return cartNames.indexOf(c) === -1; });
  if (unknown.length) {
    console.error('Unknown cart(s) ' + unknown.join(', ') + '. Add them to CARTS in Settings.gs to match config.js.');
    return 'Unknown cart: ' + unknown.join(', ') + '. Please let the tech office know.';
  }
  r.carts = cartNames.filter(function (c) { return r.carts.indexOf(c) !== -1; }); // dedupe, keep standard order

  if (!Array.isArray(r.sessions) || !r.sessions.length) return 'Please add at least one date.';
  if (r.sessions.length > MAX_DATES) return 'Please book at most ' + MAX_DATES + ' dates at a time.';
  const now = new Date();
  for (let i = 0; i < r.sessions.length; i++) {
    const s = r.sessions[i];
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s.date) || !/^\d{2}:\d{2}$/.test(s.start) || !/^\d{2}:\d{2}$/.test(s.end)) {
      return 'Please fill in a date, start time and end time for each date.';
    }
    s.startDate = Utilities.parseDate(s.date + ' ' + s.start, tz, 'yyyy-MM-dd HH:mm');
    s.endDate = Utilities.parseDate(s.date + ' ' + s.end, tz, 'yyyy-MM-dd HH:mm');
    if (s.start < DELIVERY_START || s.start > DELIVERY_END) {
      const at = function (t) { return fmtTime_(Utilities.parseDate(s.date + ' ' + t, tz, 'yyyy-MM-dd HH:mm'), tz); };
      return 'Carts can only be delivered between ' + at(DELIVERY_START) + ' and ' + at(DELIVERY_END) + '.';
    }
    if (s.endDate <= s.startDate) return 'End time must be after start time.';
    if (s.endDate < now) return 'One of your dates has already passed.';
  }
  return null;
}

function lower_(s) {
  return String(s).toLowerCase();
}

/** NOTIFY_EMAIL as a list of addresses. */
function notifyList_() {
  return String(NOTIFY_EMAIL || '').split(',').map(function (e) { return e.trim(); }).filter(Boolean);
}

function fmtTime_(d, tz) {
  return Utilities.formatDate(d, tz, 'h:mm a');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Run this once from the editor to grant calendar access and confirm the calendar ID works. */
function testSetup() {
  const cal = CalendarApp.getCalendarById(CALENDAR_ID);
  if (!cal) throw new Error('Calendar not found. Check CALENDAR_ID.');
  Logger.log('Connected to calendar: ' + cal.getName() + ' (time zone ' + Session.getScriptTimeZone() + ')');
  Logger.log(notifyList_().length ? 'New bookings will invite: ' + notifyList_().join(', ') : 'NOTIFY_EMAIL is empty, so only the requester is invited.');
}
