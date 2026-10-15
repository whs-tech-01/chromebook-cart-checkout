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
const CACHE_SECONDS = 180;
const WARM_MINUTES = 5;
let lastSource_ = '';

// Where publishBookings_ writes the calendar for the site. Override in Settings.gs if the repo moves.
const GITHUB_REPO_ = typeof GITHUB_REPO !== 'undefined' ? GITHUB_REPO : 'whs-tech-01/chromebook-cart-checkout';
const GITHUB_BRANCH_ = typeof GITHUB_BRANCH !== 'undefined' ? GITHUB_BRANCH : 'main';
const DATA_PATH = 'data/bookings.json';

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

  // Update the site's copy of the calendar so other people see this booking within a minute or two.
  try {
    publishBookings_();
  } catch (err) {
    console.error('Publish after booking failed: ' + (err && err.message ? err.message : err));
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

  // Most requests are answered from the cache, which warmCache() refreshes every few minutes.
  // A new booking changes the version, so it shows up right away. Edits made directly in
  // Google Calendar appear within about WARM_MINUTES.
  const cached = CacheService.getScriptCache().get(cacheKey_(from, to));
  if (cached) return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);
  return ContentService.createTextOutput(refreshRange_(from, to, start, end, CACHE_SECONDS)).setMimeType(ContentService.MimeType.JSON);
}

function cacheKey_(from, to) {
  return ['bookings', version_(), from, to].join(':');
}

/** Read bookings for a date range from Calendar, cache the JSON, and return it. */
function refreshRange_(from, to, start, end, seconds) {
  const tz = Session.getScriptTimeZone();
  const began = Date.now();
  const bookings = retry_(function () { return bookingsBetween_(null, start, end); }).map(function (b) { return toPublic_(b, tz); });
  // "source" and "ms" are for troubleshooting: which reader ran and how long it took.
  const text = JSON.stringify({ ok: true, bookings: bookings, source: lastSource_, ms: Date.now() - began });
  try { CacheService.getScriptCache().put(cacheKey_(from, to), text, seconds); } catch (err) { console.warn('Cache put failed: ' + err); }
  return text;
}

/**
 * Runs every few minutes (installed by testSetup) so the calendar is already cached
 * for this month and the next two when people open the form.
 */
/** The booking fields the form shows. */
function toPublic_(b, tz) {
  return {
    date: Utilities.formatDate(b.start, tz, 'yyyy-MM-dd'),
    start: Utilities.formatDate(b.start, tz, 'HH:mm'),
    end: Utilities.formatDate(b.end, tz, 'HH:mm'),
    carts: b.carts,
    teacher: b.teacher,
    location: b.location,
  };
}

/**
 * Publish bookings from last month through the next 12 months to data/bookings.json on GitHub,
 * so the form can load the calendar from its own site instead of waiting on this script.
 * Needs a GITHUB_TOKEN script property (see README). Only commits when something changed.
 */
function publishBookings_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN');
  if (!token) return 'skipped: no GITHUB_TOKEN script property';

  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const from = Utilities.formatDate(new Date(now.getFullYear(), now.getMonth() - 1, 1), tz, 'yyyy-MM-dd');
  const to = Utilities.formatDate(new Date(now.getFullYear(), now.getMonth() + 13, 0), tz, 'yyyy-MM-dd');
  const start = Utilities.parseDate(from + ' 00:00', tz, 'yyyy-MM-dd HH:mm');
  const end = new Date(Utilities.parseDate(to + ' 00:00', tz, 'yyyy-MM-dd HH:mm').getTime() + 24 * 60 * 60 * 1000);
  const bookings = retry_(function () { return bookingsBetween_(null, start, end); })
    .map(function (b) { return toPublic_(b, tz); })
    .sort(function (a, b) { return (a.date + a.start).localeCompare(b.date + b.start); });

  const body = JSON.stringify({ from: from, to: to, bookings: bookings });
  const hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, body, Utilities.Charset.UTF_8));
  if (hash === props.getProperty('PUBLISHED_HASH')) return 'unchanged';

  const content = JSON.stringify({ updated: now.toISOString(), from: from, to: to, bookings: bookings });
  const url = 'https://api.github.com/repos/' + GITHUB_REPO_ + '/contents/' + DATA_PATH;
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  for (let attempt = 0; ; attempt++) {
    const current = UrlFetchApp.fetch(url + '?ref=' + encodeURIComponent(GITHUB_BRANCH_), { headers: headers, muteHttpExceptions: true });
    const sha = current.getResponseCode() === 200 ? JSON.parse(current.getContentText()).sha : undefined;
    const res = UrlFetchApp.fetch(url, {
      method: 'put',
      contentType: 'application/json',
      headers: headers,
      muteHttpExceptions: true,
      payload: JSON.stringify({
        message: 'Update cart bookings (' + bookings.length + ')',
        content: Utilities.base64Encode(content, Utilities.Charset.UTF_8),
        branch: GITHUB_BRANCH_,
        sha: sha,
      }),
    });
    const code = res.getResponseCode();
    if (code < 300) break;
    if (code === 409 && attempt < 2) continue; // file changed underneath us; fetch the new sha and retry
    throw new Error('GitHub publish failed (' + code + '): ' + res.getContentText().slice(0, 300));
  }
  props.setProperty('PUBLISHED_HASH', hash);
  return 'published ' + bookings.length + ' bookings';
}

function warmCache() {
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  for (let i = 0; i < 3; i++) {
    const first = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const last = new Date(now.getFullYear(), now.getMonth() + i + 1, 0);
    const from = Utilities.formatDate(first, tz, 'yyyy-MM-dd');
    const to = Utilities.formatDate(last, tz, 'yyyy-MM-dd');
    const start = Utilities.parseDate(from + ' 00:00', tz, 'yyyy-MM-dd HH:mm');
    const end = new Date(Utilities.parseDate(to + ' 00:00', tz, 'yyyy-MM-dd HH:mm').getTime() + 24 * 60 * 60 * 1000);
    refreshRange_(from, to, start, end, WARM_MINUTES * 60 * 2);
  }
  try {
    const result = publishBookings_();
    console.log('Publish: ' + result);
    return result;
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    return 'FAILED: ' + (err && err.message ? err.message : err);
  }
}

function bookingsViaApi_(start, end) {
  const out = [];
  let pageToken;
  do {
    const page = Calendar.Events.list(CALENDAR_ID, {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true, // expands repeating events into one entry per day
      maxResults: 2500,
      pageToken: pageToken,
      fields: 'nextPageToken,items(summary,location,start,end,status)',
    });
    (page.items || []).forEach(function (ev) {
      if (ev.status === 'cancelled' || !ev.start || !ev.start.dateTime) return; // skip all-day events
      if (!ev.summary || ev.summary.indexOf(TITLE_PREFIX) !== 0) return;
      const parts = ev.summary.slice(TITLE_PREFIX.length).split(NAME_SEP);
      out.push({
        carts: parts[0].split(CART_SEP),
        teacher: parts.slice(1).join(NAME_SEP),
        location: ev.location || '',
        start: new Date(ev.start.dateTime),
        end: new Date(ev.end.dateTime),
      });
    });
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

function version_() {
  return PropertiesService.getScriptProperties().getProperty('BOOKINGS_VERSION') || '0';
}

function bumpVersion_() {
  PropertiesService.getScriptProperties().setProperty('BOOKINGS_VERSION', String(Date.now()));
}

/**
 * Cart bookings overlapping [start, end). With the Google Calendar API service added
 * (Services > Google Calendar API) this is one fast request; otherwise it falls back to
 * CalendarApp, which makes a slow call for every property of every event.
 */
function bookingsBetween_(cal, start, end) {
  if (typeof Calendar !== 'undefined') {
    try {
      const result = bookingsViaApi_(start, end);
      lastSource_ = 'api';
      return result;
    } catch (err) {
      console.error('Calendar API failed, using CalendarApp instead: ' + err);
    }
  }
  lastSource_ = 'calendarapp';
  cal = cal || CalendarApp.getCalendarById(CALENDAR_ID);
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
  Logger.log(typeof Calendar !== 'undefined'
    ? 'Google Calendar API service is on (fast calendar loading).'
    : 'Add Services > Google Calendar API for much faster calendar loading.');

  // Keep the calendar cache warm so the form loads quickly.
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'warmCache'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('warmCache').timeBased().everyMinutes(WARM_MINUTES).create();
  PropertiesService.getScriptProperties().deleteProperty('PUBLISHED_HASH'); // force a fresh publish
  const began = Date.now();
  const published = warmCache();
  Logger.log('Calendar cache warmed in ' + (Date.now() - began) + ' ms using ' + lastSource_ +
    ', and set to refresh every ' + WARM_MINUTES + ' minutes.');
  Logger.log('Publishing to GitHub: ' + published);

  Logger.log(notifyList_().length ? 'New bookings will invite: ' + notifyList_().join(', ') : 'NOTIFY_EMAIL is empty, so only the requester is invited.');
}
