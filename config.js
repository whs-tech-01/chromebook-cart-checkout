// Edit this file to customize the form. No secrets belong here — this file is public.
window.CART_CONFIG = {
  // Paste your Apps Script "Web app URL" here (Step 3 in README.md).
  // It ends in /exec.
  scriptUrl: "https://script.google.com/macros/s/AKfycbzEIqrrIzTxpHVTKZRukyIHRk4O_brpiNPogvFB4rBj33IBonpjb08BBFbadlJyd-Tw/exec",

  // The carts that can be reserved. Names must match CARTS in apps-script/Settings.gs.
  carts: [
    { name: "Large Cart", size: 40 },
    { name: "Small Cart 1", size: 36 },
    { name: "Small Cart 2", size: 36 },
    { name: "Small Cart 3", size: 36 },
  ],

  // Carts can only be delivered during I.T. work hours (24-hour HH:MM).
  // "Carts arrive" times are limited to this window. Must match DELIVERY_* in Settings.gs.
  deliveryStart: "07:30",
  deliveryEnd: "15:45",

  // Latest time an event can end (24-hour HH:MM).
  dayEnd: "22:00",

  // "Questions? Contact the tech office." links to this address.
  contactEmail: "whs@khsd.freshdesk.com",
};
