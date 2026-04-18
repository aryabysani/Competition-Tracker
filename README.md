# Competition Tracker — Chrome Extension

Never miss a deadline on Unstop. This extension shows live countdowns for every competition round you're registered for, right in your browser.

---

## What it does

- Automatically picks up competitions you visit on Unstop
- Shows a live countdown for every upcoming round
- Sends you a notification 48 hours, 24 hours, and 1 hour before a deadline
- Lets you manually add competitions from any platform

---

## Installation (one-time setup)

Chrome doesn't install extensions from outside its store by default. Follow these steps exactly — it takes about 2 minutes.

### Step 1 — Download the extension files

1. On this GitHub page, click the green **Code** button near the top right
2. Click **Download ZIP**
3. Once downloaded, find the ZIP file (usually in your **Downloads** folder)
4. Right-click it and select **Extract All** (Windows) or double-click it (Mac)
5. You should now have a folder — open it and look for a folder called **`dist`** inside it. Remember where this `dist` folder is.

### Step 2 — Open Chrome Extensions

1. Open **Google Chrome**
2. In the address bar at the top, type:
   ```
   chrome://extensions
   ```
   and press **Enter**
3. You'll see the Extensions page

### Step 3 — Turn on Developer Mode

1. Look for a toggle in the **top right corner** of the Extensions page that says **Developer mode**
2. Click it to turn it **on** — the toggle should turn blue
3. Three new buttons will appear at the top left: "Load unpacked", "Pack extension", and "Update"

### Step 4 — Load the extension

1. Click the **Load unpacked** button (top left)
2. A file picker window will open — navigate to the `dist` folder you extracted in Step 1
3. Click on the `dist` folder to select it, then click **Select Folder** (Windows) or **Open** (Mac)
4. The extension will appear in your list as **Competition Tracker**

### Step 5 — Pin it to your toolbar (recommended)

1. Click the **puzzle piece icon** (🧩) in the top right of Chrome, next to the address bar
2. Find **Competition Tracker** in the list
3. Click the **pin icon** next to it so it stays visible in your toolbar

---

## How to use it

### Tracking a competition automatically

1. Go to **[unstop.com](https://unstop.com)** and log in
2. Open any competition page that you've **already registered for**
3. The extension will detect it automatically — a number badge will appear on the extension icon

### Viewing your deadlines

Click the **Competition Tracker icon** in your toolbar. You'll see:
- All your upcoming competitions grouped by name
- A live countdown for each round
- Colour-coded urgency (green → yellow → red as the deadline approaches)

### Adding a competition manually

If you want to track a competition from another platform:

1. Click the extension icon
2. Click **➕ Add New** at the bottom
3. Fill in the competition name and add your round deadlines
4. Click **Save Competition**

### Quick links

Inside the extension you'll find two buttons at the top:
- **Go to Unstop** — opens Unstop in a new tab
- **My Registrations** — takes you directly to your list of registered competitions on Unstop

---

## Notifications

You'll receive browser notifications at:
- **48 hours** before a deadline
- **24 hours** before a deadline
- **1 hour** before a deadline

Make sure Chrome notifications are allowed. If you're not getting them, go to Chrome Settings → Privacy and Security → Notifications and make sure Chrome is permitted.

---

## Removing a competition

Click the **×** button on any competition card to remove it. The badge and notifications will update immediately.

---

## Updating the extension

When a new version is released:

1. Download and extract the new ZIP (same as Step 1)
2. Go to `chrome://extensions`
3. Find Competition Tracker and click the **refresh icon** (↻) on its card
4. Select the new `dist` folder

---

## Troubleshooting

**The extension isn't detecting my competition**
- Make sure you're logged in to Unstop
- Try refreshing the competition page after logging in
- The competition must be one you've already registered for

**I'm not seeing the extension icon**
- Follow Step 5 above to pin it to your toolbar

**Notifications aren't showing up**
- Check that Chrome has permission to send notifications on your device

---

Built for Unstop users who hate missing deadlines.
