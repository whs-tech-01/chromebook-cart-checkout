/**
 * Settings for the Chromebook Cart Event Checkout backend.
 *
 * Keep this as its own file in the Apps Script project, next to Code.gs.
 * Code.gs can then be replaced with a newer version without losing these values.
 */

// Calendar ID from Google Calendar > Settings > (your calendar) > "Integrate calendar" > Calendar ID.
// Looks like c_abc123...@group.calendar.google.com. This is NOT the "secret address in iCal format".
const CALENDAR_ID = 'PASTE_CALENDAR_ID_HERE';

// Only accept requests from emails ending in this domain. Leave as '' to accept any email.
const ALLOWED_EMAIL_DOMAIN = '@kernhigh.org';

// Who gets an email with the full details of every new booking. Separate several with commas.
// Leave as '' to send no booking emails.
const NOTIFY_EMAIL = '';

// Cart names and how many Chromebooks each holds. Names must match config.js.
const CARTS = {
  'Large Cart': 40,
  'Small Cart 1': 36,
  'Small Cart 2': 36,
};

// Send the requester a calendar invite for each booked date.
const INVITE_REQUESTER = true;

// Most dates one request can book.
const MAX_DATES = 10;

// Carts can only be delivered during these hours (24-hour HH:MM). Must match config.js.
const DELIVERY_START = '07:30';
const DELIVERY_END = '15:45';
