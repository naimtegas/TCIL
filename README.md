# TCIL Dashboard

Dashboard website for **TCIL (Tegas Community Innovative Learning)** — an Evenesis-like platform for managing events, members, budgets, documents, and travel reports.

## Features

- 🔐 **Login** — member authentication with Firebase Auth (Email/Password & Google Sign-In)
- 📊 **Overview** — stats, recent activity, upcoming events
- 📅 **Events** — create/edit/delete events with categories, status, budget, attendees
- 👥 **Members** — member directory with roles, departments, status
- 💰 **Budget** — a single master fund with one "Add funds" form (money in) and one "Edit total" form. Every event carries its own budget allocated **out of** the fund: per-event expense recording with notes, over-budget warnings, allocation history (audit trail), and fund returns when events are deleted or their budgets reduced
- 📄 **Documents** — repository for meeting minutes, reports, proposals, SOPs
- ✈️ **Travel Reports** — member travel records
- ⚙️ **Settings** — theme toggle (light/dark), notifications, Firebase config placeholder

## How to Run

Any static file server works:

```bash
cd "TCIL DASHBOARD"
python3 -m http.server 8080
# or
npx serve
```

Then open `http://localhost:8080`.

## Demo Login

- Email: `ahmad.faiz@tcil.edu.my`
- Password: `password123` (any password works in demo mode)

## Data / Persistence

- **Firebase Realtime Database**: Connected live to `https://tcil-93af5-default-rtdb.asia-southeast1.firebasedatabase.app` (Project: `tcil-93af5`). All events, members, fund balances, documents, and travel records synchronize live across clients.
- **Offline / Local Storage**: Cached locally in browser `localStorage` via `SafeStorage` for instant load and offline resilience.
- **Authentication**: Supports Firebase Authentication (Email/Password & Google Sign-In). Automatically links authenticated Google accounts with the TCIL members directory.

## Project Structure

```
TCIL DASHBOARD/
├── index.html          # Single-page app shell + all modals
├── data.json           # Seed/demo data
├── css/
│   └── style.css       # Full stylesheet (light + dark themes)
└── js/
    ├── firebase-config.js  # Firebase project & RTDB config
    └── app.js          # All app logic (data, auth, rendering, CRUD, RTDB sync)
```

## Next Steps (Registration Platform)

A separate **TCIL Registration Platform** (in the sibling folder) will handle member event registrations with Firebase as the source of truth. Its data will be pulled into this dashboard's *Registrations* section.
