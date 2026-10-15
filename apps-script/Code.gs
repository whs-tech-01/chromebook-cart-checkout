/**
 * Chromebook Cart Event Checkout — Google Apps Script backend.
 *
 * Runs under YOUR Google account and writes reservations to your calendar.
 * The GitHub Pages form sends requests here; nothing secret lives on GitHub.
 *
 * Setup: see README.md, Step 2.
 */

// ===== SETTINGS =====

// Calendar ID from Google Calendar > Settings > (your calendar) > "Integrate calendar" > Calendar ID.
// Looks like abc123...@group.calendar.google.com, or your own email for your main calendar.
// This is NOT the "secret address in iCal format".
const CALENDAR_ID = 'PASTE_CALENDAR_ID_HERE';

// Only accept requests from emails ending in this domain (e.g. '@yourschool.org').
// Leave as '' to accept any email.
const ALLOWED_EMAIL_DOMAIN = '';

// Must match the cart names in config.js.
const CARTS = ['Large Cart', 'Small Cart 1', 'Small Cart 2'];

// Send the requester a calendar invite for each booked date.
const INVITE_REQUESTER = true;

// Most dates one request can book.
const MAX_DATES = 10;

// Carts can only be delivered during these hours (24-hour HH:MM). Must match config.js.
const DELIVERY_START = '07:30';
const DELIVERY_END = '15:45';

// ===== END SETTINGS =====

const TITLE_PREFIX = '[Chromebook] ';
const CART_SEP = ' + ';
const NAME_SEP = ' — ';

/** Book one or more carts for one or more dates. Called by the form with a JSON body. */
function doPost(e) {
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
  lock.waitLock(20000);
  try {
    const cal = CalendarApp.getCalendarById(CALENDAR_ID);

    // Check every date before booking any, so a request is all-or-nothing.
    const conflicts = [];
    req.sessions.forEach(function (s) {
      bookingsBetween_(cal, s.startDate, s.endDate).forEach(function (b) {
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
    const description = [
      'Requested by: ' + req.name,
      'Email: ' + req.email,
      req.contactName ? 'Contact person: ' + req.contactName + (req.contactInfo ? ' (' + req.contactInfo + ')' : '') : '',
      'Carts: ' + req.carts.join(', '),
      'Location: ' + req.location,
      req.notes ? 'Notes: ' + req.notes : '',
    ].filter(Boolean).join('\n') + '\n\nBooked via the Chromebook Cart Event Checkout form.';

    const options = { description: description, location: req.location };
    if (INVITE_REQUESTER) {
      options.guests = req.email;
      options.sendInvites = true;
    }
    req.sessions.forEach(function (s) {
      cal.createEvent(title, s.startDate, s.endDate, options);
    });
  } finally {
    lock.releaseLock();
  }

  return json_({ ok: true });
}

/** List bookings in a date range so the form can show a calendar: ?from=YYYY-MM-DD&to=YYYY-MM-DD (or ?date=YYYY-MM-DD) */
function doGet(e) {
  const p = (e && e.parameter) || {};
  const from = p.from || p.date;
  const to = p.to || p.date;
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from || '') || !re.test(to || '')) return json_({ ok: false, error: 'Missing date range.' });

  const tz = Session.getScriptTimeZone();
  const start = Utilities.parseDate(from + ' 00:00', tz, 'yyyy-MM-dd HH:mm');
  const end = new Date(Utilities.parseDate(to + ' 00:00', tz, 'yyyy-MM-dd HH:mm').getTime() + 24 * 60 * 60 * 1000);
  if (end <= start || end - start > 62 * 24 * 60 * 60 * 1000) return json_({ ok: false, error: 'Range too large.' });

  const cal = CalendarApp.getCalendarById(CALENDAR_ID);
  const bookings = bookingsBetween_(cal, start, end).map(function (b) {
    return {
      date: Utilities.formatDate(b.start, tz, 'yyyy-MM-dd'),
      start: Utilities.formatDate(b.start, tz, 'HH:mm'),
      end: Utilities.formatDate(b.end, tz, 'HH:mm'),
      carts: b.carts,
      teacher: b.teacher,
      location: b.location,
    };
  });
  return json_({ ok: true, bookings: bookings });
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
  if (r.carts.some(function (c) { return CARTS.indexOf(c) === -1; })) return 'Unknown cart.';
  r.carts = CARTS.filter(function (c) { return r.carts.indexOf(c) !== -1; }); // dedupe, keep standard order

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
      return 'Carts can only be delivered between ' + DELIVERY_START + ' and ' + DELIVERY_END + '.';
    }
    if (s.endDate <= s.startDate) return 'End time must be after start time.';
    if (s.endDate < now) return 'One of your dates has already passed.';
  }
  return null;
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
}
