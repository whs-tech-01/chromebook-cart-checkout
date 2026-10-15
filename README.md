# Chromebook Cart Event Checkout

A request form, hosted free on GitHub Pages, for reserving Chromebook carts for special events. Each request is added to a Google Calendar, and a month calendar next to the form shows what's already booked.

Live at **https://whs-tech-01.github.io/chromebook-cart-checkout/**

```
Teacher fills form  ──►  GitHub Pages (index.html)  ──►  Google Apps Script  ──►  Google Calendar
   (any browser)            public, no secrets          runs as your account     event + invite
```

GitHub Pages can only host static files, so it can't write to Google Calendar by itself. A small Google Apps Script, running under your Google account, does that part. That means no passwords or keys are ever stored on GitHub.

> **About the "secret address in iCal format":** you don't need it, and it should never go in this repo. That link is **read-only**, so it can't add events, and anyone who has it can read your whole calendar.

---

## Step 1: Pick the calendar

1. Open [Google Calendar](https://calendar.google.com). Signing in with the school account that should own the bookings is recommended.
2. (Recommended) Make a dedicated calendar: **Other calendars ➕ → Create new calendar**, named something like *Chromebook Carts*.
3. Open that calendar's **Settings → Integrate calendar** and copy the **Calendar ID** (it looks like `abc123…@group.calendar.google.com`).
4. Under **Share with specific people**, add the staff who should see the bookings.

## Step 2: Create the Apps Script backend

1. Go to [script.google.com](https://script.google.com) → **New project**. Name it *Chromebook Cart Checkout*.
2. Delete the sample code and paste in everything from [`apps-script/Code.gs`](apps-script/Code.gs).
3. Click **＋ → Script** to add a second file named `Settings`. Paste in [`apps-script/Settings.gs`](apps-script/Settings.gs) and fill it in:
   - `CALENDAR_ID`: paste the ID from Step 1.
   - `ALLOWED_EMAIL_DOMAIN`: for example `'@kernhigh.org'`, so only school emails are accepted.
   - `NOTIFY_EMAIL`: where the full details of each booking, including notes, are emailed. Replying to that email goes to the requester.
   - `CARTS`: cart names and Chromebook counts. The names must match `config.js`.
   - `DELIVERY_START` / `DELIVERY_END`: the hours I.T. can move carts. These must match `config.js`.

   Settings live in their own file so that a newer `Code.gs` can be pasted over the old one without losing them.
4. Click the ⚙️ **Project Settings** and set the **Time zone** to your school's time zone. Booking times use this time zone.
5. Back in the editor, choose the `testSetup` function from the dropdown and click **Run**. Approve the permissions prompt (calendar access, and sending email if `NOTIFY_EMAIL` is set). (You may see a "Google hasn't verified this app" screen. Click **Advanced → Go to project**. It's your own script.) The log should say `Connected to calendar: …`, and a test email is sent to `NOTIFY_EMAIL` if it's set.

## Step 3: Deploy it as a web app

1. Click **Deploy → New deployment**, then the ⚙️ next to "Select type" → **Web app**.
2. Set **Execute as:** *Me*, and **Who has access:** *Anyone*.
   *("Anyone" is required so the GitHub Pages form can reach it. The script only accepts valid cart bookings and checks the email domain if you set one.)*
   > ⚠️ **Not** "Anyone within *your district*" or "Anyone with a Google account". With those settings the URL works when you open it yourself, because you're signed in, but the form's calendar shows **"Failed to fetch"** and bookings fail. If **Anyone** isn't offered, a Google Workspace admin must allow sharing outside the domain: **Admin console → Apps → Google Workspace → Drive and Docs → Sharing settings**. This can be turned on for just one organizational unit.
3. Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).

> If you edit `Code.gs` later, use **Deploy → Manage deployments → ✏️ Edit → Version: New version** so the URL stays the same.

## Step 4: Connect the form

Edit [`config.js`](config.js):

```js
scriptUrl: "https://script.google.com/macros/s/XXXXXXXX/exec",
carts: [{ name: "Large Cart", size: 40 }, ...],   // same names as CARTS in Code.gs
deliveryStart: "07:30",   // "Carts arrive" times are limited to these hours
deliveryEnd: "15:45",
dayEnd: "22:00",          // latest an event can end
contactEmail: "whs@khsd.freshdesk.com",
```

Commit the change. The web app URL is safe to put in a public repo because it isn't a password.

> Use the `https://script.google.com/macros/s/.../exec` form of the URL. If the deploy dialog shows `/a/macros/yourdomain/s/...`, remove the `/a/yourdomain` part, or the form won't work for people who aren't signed in to the school domain.

## Step 5: Turn on GitHub Pages

1. In this repo on GitHub: **Settings → Pages**.
2. **Source:** *Deploy from a branch*. **Branch:** `main`, folder `/ (root)` → **Save**.
3. After about a minute, your form is live at `https://<your-github-username>.github.io/chromebook-cart-checkout/`.

## Step 6: Test it

1. Open the site and reserve a cart for later today.
2. Check that the event appears on the calendar, and that the email you entered got an invite.
3. Try the same cart and time again. It should be refused as already booked.

---

## How it works

- **Several carts, several days.** One request can book any mix of carts across up to 10 days, each with its own times. "+ Add another day" fills in the next date with the same times.
- **Double bookings are blocked.** The form warns as soon as a picked cart is already taken. The script checks again before saving, books all days or none, and uses a lock so two people can't take the same cart at the same moment.
- **Calendar.** The month calendar shows a colored dot for each cart booked on a day. Click a day to see the bookings, then click **Book this day** to add it to the form.
- **Event format.** One calendar event is created per day. The title is `[Chromebook] Large Cart + Small Cart 1 — Jane Smith`, with the event location as the location and the details in the description. The script uses the `[Chromebook]` prefix to recognize bookings, so don't rename those events by hand.
- **Cancelling.** Delete the event from Google Calendar, and the slot opens up again.
- **Booking emails.** Each booking emails `NOTIFY_EMAIL` with the carts, total Chromebooks, dates, location, requester, contact person and notes. The notes are also in each calendar event's description.
- **Updating the script.** Paste the new `Code.gs` over the old one (`Settings.gs` stays as it is), then go to **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The URL stays the same.
- **Spam.** The form has a hidden honeypot field, and `ALLOWED_EMAIL_DOMAIN` restricts submissions to school email addresses.

## Files

| File | Purpose |
|---|---|
| `index.html` | The form page, with green and gold colors from the school logo |
| `config.js` | Web app URL, carts, delivery hours, and contact email |
| `assets/logo.jpg` | School logo |
| `apps-script/Code.gs` | Google Apps Script backend. Paste it into script.google.com; it isn't run from GitHub |
| `apps-script/Settings.gs` | Backend settings: calendar, email domain, notification email, carts, hours |
