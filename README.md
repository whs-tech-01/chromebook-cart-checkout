# Chromebook Cart Checkout

A request form, hosted free on GitHub Pages, that teachers use to reserve a Chromebook cart. Each request is added to a Google Calendar.

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
3. Edit the settings at the top:
   - `CALENDAR_ID`: paste the ID from Step 1.
   - `ALLOWED_EMAIL_DOMAIN`: for example `'@yourschool.org'`, so only school emails are accepted.
   - `CARTS`: your cart names. These must match `config.js`.
4. Click the ⚙️ **Project Settings** and set the **Time zone** to your school's time zone. Booking times use this time zone.
5. Back in the editor, choose the `testSetup` function from the dropdown and click **Run**. Approve the permissions prompt. (You may see a "Google hasn't verified this app" screen. Click **Advanced → Go to project**. It's your own script.) The log should say `Connected to calendar: …`.

## Step 3: Deploy it as a web app

1. Click **Deploy → New deployment**, then the ⚙️ next to "Select type" → **Web app**.
2. Set **Execute as:** *Me*, and **Who has access:** *Anyone*.
   *("Anyone" is required so the GitHub Pages form can reach it. The script only accepts valid cart bookings and checks the email domain if you set one.)*
3. Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).

> If you edit `Code.gs` later, use **Deploy → Manage deployments → ✏️ Edit → Version: New version** so the URL stays the same.

## Step 4: Connect the form

Edit [`config.js`](config.js):

```js
scriptUrl: "https://script.google.com/macros/s/XXXXXXXX/exec",
carts: ["Cart 1", "Cart 2", "Cart 3", "Cart 4"],   // same names as in Code.gs
dayStart: "07:00",
dayEnd: "16:00",
```

Commit the change. The web app URL is safe to put in a public repo because it isn't a password.

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

- **Double bookings are blocked.** The script checks the calendar before saving and uses a lock so two teachers can't book the same cart at the same moment.
- **Availability panel.** When a teacher picks a date, the form shows which carts are already booked and by whom.
- **Event format.** The event title is `[Chromebook] Cart 2 — Jane Smith`, with the room as the location and the details in the description. The script uses the `[Chromebook]` prefix to recognize bookings, so don't rename those events by hand.
- **Cancelling.** Delete the event from Google Calendar, and the slot opens up again.
- **Spam.** The form has a hidden honeypot field, and `ALLOWED_EMAIL_DOMAIN` restricts submissions to school email addresses.

## Files

| File | Purpose |
|---|---|
| `index.html` | The form page, with green and gold colors from the school logo |
| `config.js` | Web app URL, cart names, and time range |
| `assets/logo.jpg` | School logo |
| `apps-script/Code.gs` | Google Apps Script backend. Paste it into script.google.com; it isn't run from GitHub |
