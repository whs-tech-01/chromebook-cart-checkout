/**
 * Chromebook Cart Checkout — Google Apps Script backend.
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

// Must match the carts list in config.js.
const CARTS = ['Cart 1', 'Cart 2', 'Cart 3', 'Cart 4'];

// Send the teacher a calendar invite when their booking is confirmed.
const INVITE_REQUESTER = true;

// ===== END SETTINGS =====

const TITLE_PREFIX = '[Chromebook] ';

/** Book a cart. Called by the form with a JSON body. */
function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Invalid request.' });
  }

  const error = validate_(req);
  if (error) return json_({ ok: false, error: error });

  const tz = Session.getScriptTimeZone();
  const start = Utilities.parseDate(req.date + ' ' + req.start, tz, 'yyyy-MM-dd HH:mm');
  const end = Utilities.parseDate(req.date + ' ' + req.end, tz, 'yyyy-MM-dd HH:mm');
  if (end <= start) return json_({ ok: false, error: 'End time must be after start time.' });
  if (end < new Date()) return json_({ ok: false, error: 'That time has already passed.' });

  // Lock so two teachers can't grab the same cart at the same moment.
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cal = CalendarApp.getCalendarById(CALENDAR_ID);
    const clash = bookingsBetween_(cal, start, end).find(function (b) { return b.cart === req.cart; });
    if (clash) {
      return json_({
        ok: false,
        error: req.cart + ' is already booked ' + fmtTime_(clash.start, tz) + '–' + fmtTime_(clash.end, tz) +
          ' by ' + clash.teacher + '. Please pick another cart or time.',
      });
    }

    const description = [
      'Teacher: ' + req.name,
      'Email: ' + req.email,
      'Room: ' + req.room,
      req.students ? 'Students: ' + req.students : '',
      req.notes ? 'Notes: ' + req.notes : '',
    ].filter(Boolean).join('\n') + '\n\nBooked via the Chromebook Cart Checkout form.';

    const options = { description: description, location: 'Room ' + req.room };
    if (INVITE_REQUESTER) {
      options.guests = req.email;
      options.sendInvites = true;
    }
    cal.createEvent(TITLE_PREFIX + req.cart + ' — ' + req.name, start, end, options);
  } finally {
    lock.releaseLock();
  }

  return json_({ ok: true });
}

/** List bookings for a date so the form can show what's taken: ?date=YYYY-MM-DD */
function doGet(e) {
  const date = e && e.parameter && e.parameter.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return json_({ ok: false, error: 'Missing date.' });

  const tz = Session.getScriptTimeZone();
  const dayStart = Utilities.parseDate(date + ' 00:00', tz, 'yyyy-MM-dd HH:mm');
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const cal = CalendarApp.getCalendarById(CALENDAR_ID);

  const bookings = bookingsBetween_(cal, dayStart, dayEnd).map(function (b) {
    return { cart: b.cart, teacher: b.teacher, start: fmtTime_(b.start, tz), end: fmtTime_(b.end, tz) };
  });
  return json_({ ok: true, bookings: bookings });
}

function bookingsBetween_(cal, start, end) {
  return cal.getEvents(start, end)
    .filter(function (ev) { return ev.getTitle().indexOf(TITLE_PREFIX) === 0; })
    .map(function (ev) {
      const rest = ev.getTitle().slice(TITLE_PREFIX.length);
      const parts = rest.split(' — ');
      return { cart: parts[0], teacher: parts.slice(1).join(' — '), start: ev.getStartTime(), end: ev.getEndTime() };
    });
}

function validate_(r) {
  if (!r || typeof r !== 'object') return 'Invalid request.';
  if (r.website) return 'Invalid request.'; // honeypot field filled in by bots
  const required = { name: 'your name', email: 'your email', room: 'your room', cart: 'a cart', date: 'a date', start: 'a start time', end: 'an end time' };
  for (const k in required) {
    if (!r[k] || String(r[k]).trim() === '') return 'Please enter ' + required[k] + '.';
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)) return 'Please enter a valid email.';
  if (ALLOWED_EMAIL_DOMAIN && !r.email.toLowerCase().endsWith(ALLOWED_EMAIL_DOMAIN.toLowerCase())) {
    return 'Please use your ' + ALLOWED_EMAIL_DOMAIN + ' email.';
  }
  if (CARTS.indexOf(r.cart) === -1) return 'Unknown cart.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return 'Invalid date.';
  if (!/^\d{2}:\d{2}$/.test(r.start) || !/^\d{2}:\d{2}$/.test(r.end)) return 'Invalid time.';
  ['name', 'room', 'notes', 'students'].forEach(function (k) {
    if (r[k]) r[k] = String(r[k]).slice(0, 500);
  });
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
