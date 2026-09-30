// ============================================================
// TCIL Members' Portal — application logic
// Demo build: data is held in this browser (localStorage) and
// seeded from data.json. Firebase comes in a later build.
// ============================================================

// Safe storage wrapper — falls back to in-memory if localStorage
// is unavailable (private mode, sandboxed preview, etc.)
const SafeStorage = {
    _mem: {},
    available: (function() {
        try {
            const k = '__tcil_probe__';
            localStorage.setItem(k, '1');
            localStorage.removeItem(k);
            return true;
        } catch (e) {
            return false;
        }
    })(),
    get(key) {
        try {
            if (this.available) return localStorage.getItem(key);
        } catch (e) {}
        return this._mem[key] || null;
    },
    set(key, val) {
        try {
            if (this.available) localStorage.setItem(key, val);
        } catch (e) {}
        this._mem[key] = val;
    },
    remove(key) {
        try {
            if (this.available) localStorage.removeItem(key);
        } catch (e) {}
        delete this._mem[key];
    }
};

const DATA_VERSION = 7; // bump to force a reseed of the local demo data

let appData = null;
let currentEventFilter = 'all';
let currentDocumentFilter = 'all';
let alertTotal = 0;

// Firebase state
let firebaseApp = null;
let firebaseDb = null;
let firebaseAuth = null;
let isFirebaseOnline = false;

function toArray(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val.filter(Boolean);
    return Object.keys(val).map(function(k) { return val[k]; }).filter(Boolean);
}

function normalizeFirebaseData(val) {
    if (!val) return getDefaultData();
    return {
        __v: val.__v || DATA_VERSION,
        users: toArray(val.users),
        events: toArray(val.events).map(function(e) {
            if (!Array.isArray(e.ledger)) e.ledger = toArray(e.ledger);
            return e;
        }),
        fund: val.fund ? {
            total: typeof val.fund.total === 'number' ? val.fund.total : 0,
            ledger: toArray(val.fund.ledger),
            ts: val.fund.ts || Date.now()
        } : getDefaultData().fund,
        documents: toArray(val.documents),
        travelReports: toArray(val.travelReports),
        activities: toArray(val.activities)
    };
}

// ============================================================
// Clean data starter
// ============================================================
function getDefaultData() {
    return {
        __v: DATA_VERSION,
        users: [],
        events: [],
        fund: { total: 0, ledger: [] },
        documents: [],
        travelReports: [],
        activities: []
    };
}

function loadData() {
    const saved = SafeStorage.get('tcilData');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            if (parsed && parsed.__v === DATA_VERSION) {
                appData = parsed;
                return;
            }
            // stale demo data (older version) — discard and reseed
        } catch (e) {
            console.error('Saved data unreadable — reseeding.', e);
        }
    }
    appData = getDefaultData();
    SafeStorage.set('tcilData', JSON.stringify(appData));
    // Try to refresh from data.json (in case it was edited server-side)
    fetch('data.json')
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!saved) { // only on first run — don't clobber local changes
                appData = data;
                SafeStorage.set('tcilData', JSON.stringify(appData));
                initializeApp();
            }
        })
        .catch(function() { /* offline / no server — defaults already in place */ });
}

function saveData() {
    SafeStorage.set('tcilData', JSON.stringify(appData));
    if (firebaseDb) {
        firebaseDb.ref().set(appData).catch(function(err) {
            console.error('Firebase save error:', err);
        });
    }
}

// ============================================================
// Firebase Realtime Database & Authentication
// ============================================================
function initFirebase() {
    if (typeof firebase === 'undefined') {
        console.warn('Firebase SDK not available — running in local storage mode.');
        updateDatabaseStatusUI('offline');
        return;
    }
    try {
        const config = (typeof FIREBASE_CONFIG !== 'undefined') ? Object.assign({}, FIREBASE_CONFIG) : {};
        const storedKey = SafeStorage.get('tcilApiKey');
        if (storedKey) config.apiKey = storedKey;

        if (!firebase.apps.length) {
            const initObj = {
                databaseURL: config.databaseURL || "https://tcil-93af5-default-rtdb.asia-southeast1.firebasedatabase.app",
                projectId: config.projectId || "tcil-93af5",
                authDomain: config.authDomain || "tcil-93af5.firebaseapp.com"
            };
            if (config.apiKey && config.apiKey.trim().length > 0) {
                initObj.apiKey = config.apiKey.trim();
            }
            firebaseApp = firebase.initializeApp(initObj);
        } else {
            firebaseApp = firebase.app();
        }

        if (firebaseApp) {
            firebaseDb = firebaseApp.database();

            // Track connection status
            firebaseDb.ref('.info/connected').on('value', function(snap) {
                isFirebaseOnline = snap.val() === true;
                updateDatabaseStatusUI(isFirebaseOnline ? 'online' : 'connecting');
            });

            // Sync Realtime Database
            firebaseDb.ref().on('value', function(snapshot) {
                const val = snapshot.val();
                if (val) {
                    appData = normalizeFirebaseData(val);
                    SafeStorage.set('tcilData', JSON.stringify(appData));
                    if (typeof initializeApp === 'function') {
                        initializeApp();
                    }
                    if (firebaseAuth && firebaseAuth.currentUser) {
                        const cur = firebaseAuth.currentUser;
                        const match = appData.users.find(function(u) {
                            return (u.email && u.email.toLowerCase() === (cur.email || '').toLowerCase()) || (u.uid && u.uid === cur.uid);
                        });
                        if (match) {
                            setCurrentUser(match);
                        } else {
                            syncAuthenticatedMember(cur);
                        }
                    }
                } else {
                    console.log('Firebase Realtime Database empty — seeding initial data');
                    firebaseDb.ref().set(getDefaultData());
                }
            }, function(err) {
                console.error('Firebase RTDB error:', err);
                updateDatabaseStatusUI('offline');
            });

            // Initialize Auth if apiKey is present
            if (config.apiKey && config.apiKey.trim().length > 0) {
                try {
                    firebaseAuth = firebaseApp.auth();
                    initAuthListener();
                } catch (ae) {
                    console.warn('Firebase Auth warning:', ae);
                }
            }
            updateDatabaseStatusUI(isFirebaseOnline ? 'online' : 'connecting');
        }
    } catch (e) {
        console.error('Firebase initialization error:', e);
        updateDatabaseStatusUI('offline');
    }
}

function initAuthListener() {
    if (!firebaseAuth) return;
    firebaseAuth.getRedirectResult().then(function(result) {
        if (result && result.user) {
            syncAuthenticatedMember(result.user);
            document.getElementById('loginScreen').style.display = 'none';
            document.getElementById('dashboard').style.display = 'flex';
        }
    }).catch(function(err) {
        if (err.code !== 'auth/credential-already-in-use') {
            console.warn('Redirect sign-in result:', err);
        }
    });
    firebaseAuth.onAuthStateChanged(function(user) {
        if (user) {
            syncAuthenticatedMember(user);
            document.getElementById('loginScreen').style.display = 'none';
            document.getElementById('dashboard').style.display = 'flex';
        } else {
            if (!SafeStorage.get('tcilUser')) {
                document.getElementById('dashboard').style.display = 'none';
                document.getElementById('loginScreen').style.display = 'grid';
            }
        }
    });
}

function updateDatabaseStatusUI(state) {
    const badge = document.getElementById('dbStatusBadge');
    const pill = document.getElementById('dbStatusPill');
    const pillText = document.getElementById('dbStatusPillText');
    const note = document.getElementById('dbStatusNote');

    const hasAuth = !!firebaseAuth;

    if (state === 'online' || isFirebaseOnline) {
        if (badge) {
            badge.className = 'tag tag-green';
            badge.textContent = hasAuth ? 'Live (Auth + RTDB)' : 'Live (RTDB)';
        }
        if (pill) {
            pill.className = 'db-pill';
            if (pillText) pillText.textContent = 'Live';
            pill.title = 'Firebase Realtime Database: Connected & syncing live';
        }
        if (note) {
            note.textContent = hasAuth
                ? 'Firebase Realtime Database and Firebase Authentication are active and syncing live.'
                : 'Realtime Database is connected and syncing live. Enter your Firebase Web API Key above to enforce Firebase Authentication for email/password sign-in.';
        }
    } else if (state === 'connecting') {
        if (badge) {
            badge.className = 'tag tag-yellow';
            badge.textContent = 'Connecting...';
        }
        if (pill) {
            pill.className = 'db-pill connecting';
            if (pillText) pillText.textContent = 'Connecting';
        }
    } else {
        if (badge) {
            badge.className = 'tag tag-red';
            badge.textContent = 'Offline';
        }
        if (pill) {
            pill.className = 'db-pill offline';
            if (pillText) pillText.textContent = 'Offline';
            pill.title = 'Firebase disconnected. Changes saved locally in browser.';
        }
        if (note) {
            note.textContent = 'Unable to reach Firebase. Running in offline mode using local browser storage.';
        }
    }
}

function saveFirebaseSettings() {
    const keyInput = document.getElementById('settingApiKey');
    const apiKey = keyInput ? keyInput.value.trim() : '';
    if (!apiKey) {
        alert('Please enter your Firebase Web API Key (found in Firebase Console > Project Settings > General).');
        return;
    }
    SafeStorage.set('tcilApiKey', apiKey);
    if (typeof FIREBASE_CONFIG !== 'undefined') FIREBASE_CONFIG.apiKey = apiKey;

    if (firebaseApp) {
        firebaseApp.delete().then(function() {
            firebaseApp = null;
            firebaseDb = null;
            firebaseAuth = null;
            initFirebase();
            alert('Firebase settings saved! Realtime Database and Firebase Auth re-initialized.');
        }).catch(function() {
            initFirebase();
            alert('Firebase settings saved!');
        });
    } else {
        initFirebase();
        alert('Firebase settings saved and connected!');
    }
}

function syncWithFirebase() {
    if (!firebaseDb) {
        alert('Firebase Realtime Database is not connected.');
        return;
    }
    firebaseDb.ref().once('value').then(function(snapshot) {
        const val = snapshot.val();
        if (val) {
            appData = normalizeFirebaseData(val);
            SafeStorage.set('tcilData', JSON.stringify(appData));
            initializeApp();
            alert('Synced successfully with Firebase Realtime Database!');
        } else {
            alert('Firebase database is currently empty.');
        }
    }).catch(function(err) {
        alert('Failed to sync: ' + err.message);
    });
}

function pushToFirebase() {
    if (!firebaseDb) {
        alert('Firebase Realtime Database is not connected.');
        return;
    }
    if (!confirm('Push current dashboard data to Firebase Realtime Database? This will overwrite remote data with current local data.')) return;
    firebaseDb.ref().set(appData).then(function() {
        alert('Successfully pushed all local data to Firebase Realtime Database!');
    }).catch(function(err) {
        alert('Failed to push: ' + err.message);
    });
}

// ============================================================
// Authenticated Member Sync (Google / Gmail & Firebase Auth)
// ============================================================
function syncAuthenticatedMember(authUser) {
    if (!authUser || !authUser.email) {
        return Promise.resolve(null);
    }

    const email = authUser.email.trim();
    const emailLower = email.toLowerCase();
    const uid = authUser.uid;
    const photoURL = authUser.photoURL || null;
    const displayName = (authUser.displayName && authUser.displayName.trim()) ||
        email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });

    if (!appData) {
        appData = getDefaultData();
    }
    if (!Array.isArray(appData.users)) {
        appData.users = [];
    }

    function applySyncToUserList(usersList) {
        const list = Array.isArray(usersList) ? usersList.slice() : [];
        const idx = list.findIndex(function(u) {
            return (u.email && u.email.toLowerCase() === emailLower) || (u.uid && u.uid === uid);
        });

        let memberRecord;
        let isNew = false;
        let hasChanges = false;

        if (idx >= 0) {
            memberRecord = Object.assign({}, list[idx]);
            if (photoURL && memberRecord.photoURL !== photoURL) {
                memberRecord.photoURL = photoURL;
                hasChanges = true;
            }
            if (displayName && (!memberRecord.name || memberRecord.name === memberRecord.email)) {
                memberRecord.name = displayName;
                hasChanges = true;
            }
            if (uid && memberRecord.uid !== uid) {
                memberRecord.uid = uid;
                hasChanges = true;
            }
            if (!memberRecord.authProvider) {
                memberRecord.authProvider = 'google.com';
                hasChanges = true;
            }
            if (memberRecord.status !== 'active') {
                memberRecord.status = 'active';
                hasChanges = true;
            }
            memberRecord.lastLogin = new Date().toISOString();
            list[idx] = memberRecord;
        } else {
            isNew = true;
            hasChanges = true;
            const isFirst = list.length === 0;
            memberRecord = {
                id: nextId(list),
                uid: uid,
                name: displayName,
                email: email,
                role: isFirst ? 'admin' : 'member',
                department: 'General',
                status: 'active',
                joinDate: new Date().toISOString().split('T')[0],
                photoURL: photoURL,
                authProvider: 'google.com',
                lastLogin: new Date().toISOString()
            };
            list.push(memberRecord);

            // Record activity
            if (!Array.isArray(appData.activities)) appData.activities = [];
            const now = new Date();
            const pad = function(n) { return String(n).padStart(2, '0'); };
            appData.activities.unshift({
                id: nextId(appData.activities),
                user: memberRecord.name,
                action: 'registered as a member via Google',
                time: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
                      ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()),
                type: 'upload'
            });
            if (appData.activities.length > 50) appData.activities = appData.activities.slice(0, 50);
        }

        return { list: list, member: memberRecord, isNew: isNew, hasChanges: hasChanges };
    }

    if (firebaseDb) {
        return firebaseDb.ref('users').once('value').then(function(snap) {
            const remoteVal = snap.val();
            const currentRemoteUsers = toArray(remoteVal);
            const syncResult = applySyncToUserList(currentRemoteUsers);

            appData.users = syncResult.list;
            SafeStorage.set('tcilData', JSON.stringify(appData));
            setCurrentUser(syncResult.member);

            if (syncResult.hasChanges) {
                const updates = {};
                updates['users'] = appData.users;
                if (syncResult.isNew && appData.activities && appData.activities.length) {
                    updates['activities'] = appData.activities;
                }
                return firebaseDb.ref().update(updates).then(function() {
                    if (typeof renderMembersTable === 'function') renderMembersTable();
                    if (typeof renderStats === 'function') renderStats();
                    if (typeof renderRecentActivity === 'function') renderRecentActivity();
                    return syncResult.member;
                });
            } else {
                if (typeof renderMembersTable === 'function') renderMembersTable();
                if (typeof renderStats === 'function') renderStats();
                return syncResult.member;
            }
        }).catch(function(err) {
            console.warn('Realtime Database users sync error, using local state:', err);
            const syncResult = applySyncToUserList(appData.users);
            appData.users = syncResult.list;
            SafeStorage.set('tcilData', JSON.stringify(appData));
            setCurrentUser(syncResult.member);
            saveData();
            if (typeof renderMembersTable === 'function') renderMembersTable();
            if (typeof renderStats === 'function') renderStats();
            return syncResult.member;
        });
    } else {
        const syncResult = applySyncToUserList(appData.users);
        appData.users = syncResult.list;
        SafeStorage.set('tcilData', JSON.stringify(appData));
        setCurrentUser(syncResult.member);
        saveData();
        if (typeof renderMembersTable === 'function') renderMembersTable();
        if (typeof renderStats === 'function') renderStats();
        return Promise.resolve(syncResult.member);
    }
}

// ============================================================
// Auth Handlers
// ============================================================
function handleLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const btnLogin = document.getElementById('btnLogin');
    const errEl = document.getElementById('loginError');

    if (errEl) {
        errEl.style.display = 'none';
        errEl.textContent = '';
    }

    if (!email || !password) {
        if (errEl) {
            errEl.style.display = 'block';
            errEl.textContent = 'Please enter your email and password.';
        } else {
            alert('Please enter your email and password.');
        }
        return;
    }

    if (firebaseAuth) {
        if (btnLogin) {
            btnLogin.disabled = true;
            btnLogin.textContent = 'Signing in...';
        }
        firebaseAuth.signInWithEmailAndPassword(email, password)
            .then(function(userCredential) {
                return syncAuthenticatedMember(userCredential.user);
            })
            .then(function() {
                document.getElementById('loginScreen').style.display = 'none';
                document.getElementById('dashboard').style.display = 'flex';
                if (btnLogin) {
                    btnLogin.disabled = false;
                    btnLogin.textContent = 'Sign in';
                }
            })
            .catch(function(err) {
                if (btnLogin) {
                    btnLogin.disabled = false;
                    btnLogin.textContent = 'Sign in';
                }
                if (errEl) {
                    errEl.style.display = 'block';
                    if (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password') {
                        errEl.textContent = 'Incorrect password or email.';
                    } else if (err.code === 'auth/user-not-found') {
                        errEl.textContent = 'User not found in Firebase Authentication.';
                    } else if (err.code === 'auth/invalid-email') {
                        errEl.textContent = 'Invalid email address format.';
                    } else {
                        errEl.textContent = err.message || 'Failed to sign in.';
                    }
                } else {
                    alert(err.message);
                }
            });
        return;
    }

    // Direct / Database mode (prior to entering Firebase Auth Web API key)
    const known = appData ? appData.users.find(function(u) {
        return u.email.toLowerCase() === email.toLowerCase();
    }) : null;

    if (known) {
        setCurrentUser(known);
    } else {
        const newMember = {
            id: nextId(appData ? appData.users : []),
            name: email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); }),
            email: email,
            role: (appData && appData.users.length === 0) ? 'admin' : 'member',
            department: 'General',
            status: 'active',
            joinDate: new Date().toISOString().split('T')[0],
            authProvider: 'password'
        };
        if (!appData) appData = getDefaultData();
        if (!Array.isArray(appData.users)) appData.users = [];
        appData.users.push(newMember);
        saveData();
        setCurrentUser(newMember);
        if (typeof renderMembersTable === 'function') renderMembersTable();
        if (typeof renderStats === 'function') renderStats();
    }

    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('dashboard').style.display = 'flex';
}

function handleGoogleLogin() {
    const btnGoogle = document.getElementById('btnGoogleLogin');
    const errEl = document.getElementById('loginError');

    if (errEl) {
        errEl.style.display = 'none';
        errEl.textContent = '';
    }

    if (!firebaseAuth) {
        if (errEl) {
            errEl.style.display = 'block';
            errEl.textContent = 'Firebase Authentication is not available.';
        } else {
            alert('Firebase Authentication is not available.');
        }
        return;
    }

    if (btnGoogle) {
        btnGoogle.disabled = true;
        btnGoogle.style.opacity = '0.7';
    }

    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    firebaseAuth.signInWithPopup(provider)
        .then(function(result) {
            return syncAuthenticatedMember(result.user);
        })
        .then(function() {
            document.getElementById('loginScreen').style.display = 'none';
            document.getElementById('dashboard').style.display = 'flex';
            if (btnGoogle) {
                btnGoogle.disabled = false;
                btnGoogle.style.opacity = '1';
            }
        })
        .catch(function(err) {
            if (btnGoogle) {
                btnGoogle.disabled = false;
                btnGoogle.style.opacity = '1';
            }
            if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
                return;
            }
            if (err.code === 'auth/popup-blocked') {
                firebaseAuth.signInWithRedirect(provider);
                return;
            }
            if (errEl) {
                errEl.style.display = 'block';
                if (err.code === 'auth/unauthorized-domain') {
                    errEl.textContent = 'Domain not authorized. In Firebase Console > Authentication > Settings, add your domain to Authorized Domains.';
                } else if (err.code === 'auth/operation-not-allowed') {
                    errEl.textContent = 'Google provider not enabled in Firebase Console > Authentication > Sign-in method.';
                } else {
                    errEl.textContent = err.message || 'Google sign-in failed.';
                }
            } else {
                alert(err.message);
            }
        });
}

function setCurrentUser(user) {
    SafeStorage.set('tcilUser', JSON.stringify(user));
    document.getElementById('userName').textContent = user.name;
    const avatarEl = document.getElementById('userAvatar');
    if (avatarEl) {
        if (user.photoURL) {
            avatarEl.innerHTML = '<img src="' + esc(user.photoURL) + '" alt="' + esc(user.name) + '" style="width:100%;height:100%;object-fit:cover;">';
        } else {
            avatarEl.textContent = (user.name || '?').charAt(0).toUpperCase();
        }
    }
    document.getElementById('userRole').textContent = user.role === 'admin' ? 'Admin' : 'Member';
}

function handleLogout() {
    if (firebaseAuth) {
        firebaseAuth.signOut().catch(function(e) { console.error('Sign out error:', e); });
    }
    SafeStorage.remove('tcilUser');
    document.getElementById('dashboard').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'grid';
    document.getElementById('loginPassword').value = '';
    const errEl = document.getElementById('loginError');
    if (errEl) errEl.style.display = 'none';
}

function currentUser() {
    try {
        return JSON.parse(SafeStorage.get('tcilUser') || '{"name":"User"}');
    } catch (e) {
        return { name: 'User' };
    }
}

// ============================================================
// Init + navigation
// ============================================================
function initializeApp() {
    if (!appData) return;
    // Ensure every budget entry has a spend ledger (older data may not)
    // Migrate to the event-budget model:
    // - every event carries allocated/spent/ledger
    // - the master fund total covers whatever events already had allocated
    appData.events.forEach(function(e) {
        if (typeof e.allocated !== 'number') e.allocated = e.budget || 0;
        if (typeof e.spent !== 'number') e.spent = 0;
        if (!Array.isArray(e.ledger)) {
            e.ledger = [{ note: 'Initial allocation (migrated)', amount: e.allocated }];
        }
        e.budget = e.allocated;
    });
    if (!appData.fund || typeof appData.fund.total !== 'number') {
        const seeded = allocatedTotal();
        appData.fund = { total: seeded, ledger: [{ note: 'Fund started (covers existing event allocations)', amount: seeded, ts: Date.now() }] };
    } else if (!Array.isArray(appData.fund.ledger)) {
        appData.fund.ledger = [{ note: 'Fund history starts here', amount: appData.fund.total, ts: Date.now() }];
    }
    if (!Array.isArray(appData.fundTx)) appData.fundTx = [];
    renderStats();
    renderRecentActivity();
    renderUpcomingEvents();
    renderEventsTable();
    renderMembersTable();
    renderBudget();
    renderDocuments();
    renderTravelReports();
}

const SECTION_TITLES = {
    overview: 'Overview',
    events: 'Events',
    members: 'Members',
    budget: 'Budget',
    documents: 'Documents',
    travel: 'Travel Reports',
    settings: 'Settings'
};

function navigateTo(section) {
    document.querySelectorAll('.nav-item').forEach(function(item) {
        item.classList.toggle('active', item.dataset.section === section);
    });
    document.querySelectorAll('.view').forEach(function(v) {
        v.classList.remove('active');
    });
    const target = document.getElementById(section);
    if (target) target.classList.add('active');
    document.getElementById('pageTitle').textContent = SECTION_TITLES[section] || 'Overview';
    document.querySelector('.main').scrollIntoView({ block: 'start' });
    window.scrollTo(0, 0);

    // Refresh dynamic content when navigating
    if (section === 'budget') renderBudget();
    else if (section === 'overview') { renderStats(); renderRecentActivity(); renderUpcomingEvents(); }
    else if (section === 'events') renderEventsTable();
    else if (section === 'members') renderMembersTable();
    else if (section === 'documents') renderDocuments();
    else if (section === 'travel') renderTravelReports();
}

// ============================================================
// Overview
// ============================================================
function renderStats() {
    document.getElementById('statTotalEvents').textContent = appData.events.length;
    document.getElementById('statActiveMembers').textContent =
        appData.users.filter(function(u) { return u.status === 'active'; }).length;
    document.getElementById('statTotalBudget').textContent = 'RM ' + fundTotal().toLocaleString();
    const sub = document.getElementById('statBudgetSub');
    if (sub) sub.textContent = 'RM ' + unallocatedTotal().toLocaleString() + ' available';
    document.getElementById('statDocuments').textContent = appData.documents.length;
    const alertEl = document.getElementById('alertCount');
    if (alertEl) alertEl.textContent = String(alertTotal);
}

function renderRecentActivity() {
    const wrap = document.getElementById('recentActivityList');
    const items = appData.activities.slice(0, 6);
    wrap.innerHTML = items.map(function(a) {
        return '<div class="log-row">' +
            '<span class="log-time">' + esc(a.time) + '</span>' +
            '<span class="log-text"><b>' + esc(a.user) + '</b> ' + esc(a.action) + '</span>' +
        '</div>';
    }).join('') || '<p class="empty">No activity yet.</p>';
}

function renderUpcomingEvents() {
    const wrap = document.getElementById('upcomingEventsList');
    const upcoming = appData.events
        .filter(function(e) { return e.status === 'upcoming'; })
        .sort(function(a, b) { return new Date(a.date) - new Date(b.date); })
        .slice(0, 4);

    wrap.innerHTML = upcoming.map(function(e) {
        const d = new Date(e.date);
        return '<div class="evt">' +
            '<div class="evt-date"><b>' + d.getDate() + '</b><span>' +
                d.toLocaleString('en', { month: 'short' }) + '</span></div>' +
            '<div class="evt-info">' +
                '<h4>' + esc(e.title) + '</h4>' +
                '<p><b>' + esc(e.location) + '</b> &middot; ' + esc(e.time || '') + '</p>' +
            '</div>' +
        '</div>';
    }).join('') || '<p class="empty">No upcoming events.</p>';
}

// ============================================================
// Events
// ============================================================
const CAT_TAG = { conference: 'tag-red', workshop: 'tag-yellow', outreach: 'tag-green', social: 'tag-grey' };
const STATUS_TAG = {
    upcoming: 'tag-yellow', completed: 'tag-green', pending: 'tag-yellow',
    confirmed: 'tag-green', active: 'tag-green', approved: 'tag-green',
    draft: 'tag-grey', inactive: 'tag-grey', cancelled: 'tag-grey', submitted: 'tag-yellow'
};

function tag(text, tone) {
    return '<span class="tag ' + tone + '">' + esc(text) + '</span>';
}

function statusTag(status) {
    return tag(status.charAt(0).toUpperCase() + status.slice(1), STATUS_TAG[status] || 'tag-grey');
}

function renderEventsTable(list) {
    const tbody = document.querySelector('#eventsTable tbody');
    let events = list || appData.events.slice();
    if (!list && currentEventFilter !== 'all') {
        events = events.filter(function(e) { return e.status === currentEventFilter; });
    }
    events.sort(function(a, b) { return new Date(a.date) - new Date(b.date); });

    tbody.innerHTML = events.map(function(e) {
        return '<tr>' +
            '<td><b>' + esc(e.title) + '</b></td>' +
            '<td>' + formatDate(e.date) + (e.time ? ', ' + esc(e.time) : '') + '</td>' +
            '<td>' + esc(e.location) + '</td>' +
            '<td>' + tag(capitalize(e.category), CAT_TAG[e.category] || 'tag-grey') + '</td>' +
            '<td>' + statusTag(e.status) + '</td>' +
            '<td class="num">' + e.attendees + '</td>' +
            '<td class="num">RM ' + (e.budget || 0).toLocaleString() + '</td>' +
            '<td>' + rowActions('Event', e.id) + '</td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="8" class="empty">No events found.</td></tr>';
}

function filterEvents(filter) {
    currentEventFilter = filter;
    setFilterActive('#events', filter);
    renderEventsTable();
}

function setFilterActive(sectionSel, filter) {
    document.querySelectorAll(sectionSel + ' .fbtn').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.filter === filter);
    });
}

function updateEventBudgetHint() {
    const id = document.getElementById('eventId').value;
    const existing = id ? appData.events.find(function(x) { return x.id === parseInt(id); }) : null;
    const avail = unallocatedTotal() + (existing ? (existing.allocated || 0) : 0);
    const valStr = document.getElementById('eventBudget').value.trim();
    const hint = document.getElementById('eventBudgetHint');
    if (!hint) return;
    hint.style.display = 'block';
    if (!valStr && !id) {
        hint.textContent = 'Master fund available to allocate: RM ' + avail.toLocaleString();
        hint.className = 'formnote';
        return;
    }
    const entered = parseInt(valStr) || 0;
    if (entered > avail) {
        hint.textContent = 'Exceeds master fund by RM ' + (entered - avail).toLocaleString() + ' — only RM ' + avail.toLocaleString() + ' available.';
        hint.className = 'formnote warn';
    } else {
        hint.textContent = 'RM ' + entered.toLocaleString() + ' will be automatically allocated from the fund · RM ' + (avail - entered).toLocaleString() + ' will remain available.';
        hint.className = 'formnote';
    }
}

// ============================================================
// Friendly Time Picker Component
// ============================================================
function parseSingleTimeString(str) {
    if (!str) return null;
    str = str.trim();
    // 12-hour: e.g. "9:00 AM", "09:30pm", "11:15 am", "9:00"
    const m12 = str.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
    if (m12) {
        let h = parseInt(m12[1], 10);
        const m = m12[2];
        let ampm = m12[3] ? m12[3].toUpperCase() : (h >= 12 ? 'PM' : 'AM');
        if (h > 12) {
            h = h % 12;
            ampm = 'PM';
        } else if (h === 0) {
            h = 12;
        }
        return {
            hour: String(h).padStart(2, '0'),
            minute: m,
            ampm: ampm
        };
    }
    // simple hour e.g. "9am", "2pm"
    const mSimple = str.match(/^(\d{1,2})\s*(am|pm)$/i);
    if (mSimple) {
        let h = parseInt(mSimple[1], 10);
        let ampm = mSimple[2].toUpperCase();
        if (h > 12) {
            h = h % 12;
            ampm = 'PM';
        } else if (h === 0) {
            h = 12;
        }
        return {
            hour: String(h).padStart(2, '0'),
            minute: '00',
            ampm: ampm
        };
    }
    return null;
}

function setTimePickerValue(rawVal) {
    const input = document.getElementById('eventTime');
    if (!input) return;
    const val = (rawVal || '').trim();
    input.value = val;

    const popover = document.getElementById('timePickerPopover');
    if (popover) popover.style.display = 'none';

    const rangeCheckbox = document.getElementById('tpRangeCheckbox');
    const endSection = document.getElementById('tpEndSection');

    // Highlight matching chip
    document.querySelectorAll('.time-chip').forEach(function(chip) {
        if (chip.dataset.time === val) {
            chip.classList.add('active');
        } else {
            chip.classList.remove('active');
        }
    });

    if (!val) {
        if (rangeCheckbox) rangeCheckbox.checked = false;
        if (endSection) endSection.style.display = 'none';
        setSelectorValues('Start', '09', '00', 'AM');
        setSelectorValues('End', '01', '00', 'PM');
        return;
    }

    // Check if range: e.g. "09:00 AM – 01:00 PM" or "9:00am - 5:00pm"
    const parts = val.split(/\s*[-–—]\s*/);
    if (parts.length >= 2) {
        const startObj = parseSingleTimeString(parts[0]);
        const endObj = parseSingleTimeString(parts[1]);
        if (startObj && endObj) {
            if (rangeCheckbox) rangeCheckbox.checked = true;
            if (endSection) endSection.style.display = 'flex';
            setSelectorValues('Start', startObj.hour, startObj.minute, startObj.ampm);
            setSelectorValues('End', endObj.hour, endObj.minute, endObj.ampm);
            return;
        }
    }

    // Single time
    const singleObj = parseSingleTimeString(val);
    if (singleObj) {
        if (rangeCheckbox) rangeCheckbox.checked = false;
        if (endSection) endSection.style.display = 'none';
        setSelectorValues('Start', singleObj.hour, singleObj.minute, singleObj.ampm);
        let endH = (parseInt(singleObj.hour, 10) + 1) % 12 || 12;
        setSelectorValues('End', String(endH).padStart(2, '0'), singleObj.minute, singleObj.ampm);
    }
}

function setSelectorValues(target, hour, minute, ampm) {
    const hEl = document.getElementById('tpHour' + target);
    const mEl = document.getElementById('tpMinute' + target);
    if (hEl) {
        hEl.value = hour;
        if (hEl.value !== hour) {
            const opt = document.createElement('option');
            opt.value = hour;
            opt.textContent = hour;
            hEl.appendChild(opt);
            hEl.value = hour;
        }
    }
    if (mEl) {
        mEl.value = minute;
        if (mEl.value !== minute) {
            const opt = document.createElement('option');
            opt.value = minute;
            opt.textContent = minute;
            mEl.appendChild(opt);
            mEl.value = minute;
        }
    }
    document.querySelectorAll('.tp-ampm-btn[data-target="' + target + '"]').forEach(function(btn) {
        if (btn.dataset.period === ampm) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

function applyTimePicker() {
    const isRange = document.getElementById('tpRangeCheckbox') && document.getElementById('tpRangeCheckbox').checked;
    const hStart = document.getElementById('tpHourStart') ? document.getElementById('tpHourStart').value : '09';
    const mStart = document.getElementById('tpMinuteStart') ? document.getElementById('tpMinuteStart').value : '00';
    const ampmStartBtn = document.querySelector('.tp-ampm-btn.active[data-target="Start"]');
    const pStart = ampmStartBtn ? ampmStartBtn.dataset.period : 'AM';

    const startFormatted = hStart + ':' + mStart + ' ' + pStart;
    let finalStr = startFormatted;

    if (isRange) {
        const hEnd = document.getElementById('tpHourEnd') ? document.getElementById('tpHourEnd').value : '01';
        const mEnd = document.getElementById('tpMinuteEnd') ? document.getElementById('tpMinuteEnd').value : '00';
        const ampmEndBtn = document.querySelector('.tp-ampm-btn.active[data-target="End"]');
        const pEnd = ampmEndBtn ? ampmEndBtn.dataset.period : 'PM';
        finalStr = startFormatted + ' – ' + hEnd + ':' + mEnd + ' ' + pEnd;
    }

    const input = document.getElementById('eventTime');
    if (input) input.value = finalStr;

    // Highlight chips if matches
    document.querySelectorAll('.time-chip').forEach(function(chip) {
        if (chip.dataset.time === finalStr) {
            chip.classList.add('active');
        } else {
            chip.classList.remove('active');
        }
    });

    const popover = document.getElementById('timePickerPopover');
    if (popover) popover.style.display = 'none';
}

function initTimePicker() {
    const trigger = document.getElementById('timePickerTrigger');
    const input = document.getElementById('eventTime');
    const popover = document.getElementById('timePickerPopover');
    const rangeCheckbox = document.getElementById('tpRangeCheckbox');
    const endSection = document.getElementById('tpEndSection');
    const applyBtn = document.getElementById('tpApplyBtn');
    const clearBtn = document.getElementById('tpClearBtn');

    function togglePopover(e) {
        if (e) e.stopPropagation();
        if (!popover) return;
        const isHidden = popover.style.display === 'none' || !popover.style.display;
        popover.style.display = isHidden ? 'flex' : 'none';
    }

    if (trigger) trigger.addEventListener('click', togglePopover);
    if (input) {
        input.addEventListener('click', togglePopover);
        input.addEventListener('change', function() {
            setTimePickerValue(input.value);
        });
    }

    if (rangeCheckbox) {
        rangeCheckbox.addEventListener('change', function() {
            if (endSection) endSection.style.display = this.checked ? 'flex' : 'none';
        });
    }

    // AM/PM buttons
    document.querySelectorAll('.tp-ampm-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            const target = this.dataset.target;
            document.querySelectorAll('.tp-ampm-btn[data-target="' + target + '"]').forEach(function(b) {
                b.classList.remove('active');
            });
            this.classList.add('active');
        });
    });

    // Quick chips
    document.querySelectorAll('.time-chip').forEach(function(chip) {
        chip.addEventListener('click', function(e) {
            e.stopPropagation();
            setTimePickerValue(this.dataset.time);
            if (popover) popover.style.display = 'none';
        });
    });

    // Popover grid presets
    document.querySelectorAll('.tp-grid-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            const preset = this.dataset.preset;
            setTimePickerValue(preset);
            if (popover) popover.style.display = 'none';
        });
    });

    if (applyBtn) {
        applyBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            applyTimePicker();
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            setTimePickerValue('');
            if (popover) popover.style.display = 'none';
        });
    }

    // Close when clicking outside
    document.addEventListener('click', function(e) {
        const ctrl = document.getElementById('timePickerControl');
        if (popover && popover.style.display !== 'none') {
            if (ctrl && !ctrl.contains(e.target)) {
                popover.style.display = 'none';
            }
        }
    });
}

function openEventModal(id) {
    openModal('eventModal');
    if (id) {
        const e = appData.events.find(function(x) { return x.id === id; });
        document.getElementById('eventModalTitle').textContent = 'Edit event';
        document.getElementById('eventId').value = e.id;
        document.getElementById('eventTitle').value = e.title;
        document.getElementById('eventDate').value = e.date;
        setTimePickerValue(e.time || '');
        document.getElementById('eventLocation').value = e.location;
        document.getElementById('eventCategory').value = e.category;
        document.getElementById('eventStatus').value = e.status;
        document.getElementById('eventAttendees').value = e.attendees;
        document.getElementById('eventBudget').value = e.budget;
        document.getElementById('eventDescription').value = e.description || '';
    } else {
        document.getElementById('eventModalTitle').textContent = 'Add event';
        document.getElementById('eventId').value = '';
        document.getElementById('eventTitle').value = '';
        document.getElementById('eventDate').value = '';
        setTimePickerValue('');
        document.getElementById('eventLocation').value = '';
        document.getElementById('eventCategory').value = 'conference';
        document.getElementById('eventStatus').value = 'upcoming';
        document.getElementById('eventAttendees').value = '';
        document.getElementById('eventBudget').value = '';
        document.getElementById('eventDescription').value = '';
    }
    updateEventBudgetHint();
}

function saveEvent() {
    const id = document.getElementById('eventId').value;
    const data = {
        title: val('eventTitle'),
        date: val('eventDate'),
        time: val('eventTime'),
        location: val('eventLocation'),
        category: val('eventCategory'),
        status: val('eventStatus'),
        attendees: parseInt(val('eventAttendees')) || 0,
        budget: parseInt(val('eventBudget')) || 0,
        description: val('eventDescription')
    };
    if (!data.title || !data.date) {
        alert('Please fill in at least the event title and date.');
        return;
    }
    if (id) {
        const existing = appData.events.find(function(e) { return e.id === parseInt(id); });
        const diff = (data.budget || 0) - (existing.allocated || 0);
        if (diff > unallocatedTotal()) {
            alert('The master fund only has RM ' + unallocatedTotal().toLocaleString() + ' available. The budget increase of RM ' + diff.toLocaleString() + ' does not fit — lower the budget or add funds first.');
            return;
        }
    } else if (data.budget > unallocatedTotal()) {
        alert('The master fund only has RM ' + unallocatedTotal().toLocaleString() + ' available. This event budget of RM ' + data.budget.toLocaleString() + ' does not fit — lower the budget or add funds first.');
        return;
    }
    if (id) {
        const i = appData.events.findIndex(function(e) { return e.id === parseInt(id); });
        const existing = appData.events[i];
        const diff = (data.budget || 0) - (existing.allocated || 0);
        if (diff !== 0) {
            (existing.ledger = existing.ledger || []).push({
                note: (diff > 0 ? 'Allocation increased — took RM ' + diff.toLocaleString() + ' from the fund' : 'Allocation reduced — returned RM ' + Math.abs(diff).toLocaleString() + ' to the fund') + ' via event edit by ' + currentUser().name,
                amount: diff,
                ts: Date.now()
            });
        }
        existing.budget = data.budget;
        existing.allocated = data.budget;
        appData.events[i] = Object.assign({}, existing, data, { allocated: data.budget, ledger: existing.ledger });
        logActivity('updated event "' + data.title + '"' + (diff !== 0 ? ' (budget ' + (diff > 0 ? '+' : '−') + 'RM ' + Math.abs(diff).toLocaleString() + ')' : ''));
    } else {
        data.id = nextId(appData.events);
        data.allocated = data.budget;
        data.spent = 0;
        data.ledger = [{ note: 'Initial allocation when event created — took RM ' + (data.budget || 0).toLocaleString() + ' from the fund', amount: (data.budget || 0), ts: Date.now() }];
        appData.events.push(data);
        logActivity('created event "' + data.title + '" with RM ' + (data.budget || 0).toLocaleString() + ' allocated from the fund');
    }
    saveData();
    closeModal('eventModal');
    renderEventsTable();
    renderUpcomingEvents();
    renderBudget();
    renderStats();
}

function deleteEvent(id) {
    const e = appData.events.find(function(x) { return x.id === id; });
    if (!confirm('Delete "' + (e ? e.title : 'this event') + '"? Its RM ' + ((e && e.allocated) || 0).toLocaleString() + ' allocation returns to the master fund (spent records are kept in the fund history).')) return;
    if (e && (e.allocated || 0) > 0) {
        (appData.fund.ledger = appData.fund.ledger || []).push({
            note: 'Event "' + e.title + '" deleted — RM ' + (e.allocated || 0).toLocaleString() + ' allocation returned',
            amount: 0,
            ts: Date.now()
        });
    }
    appData.events = appData.events.filter(function(x) { return x.id !== id; });
    saveData();
    renderEventsTable();
    renderUpcomingEvents();
    renderBudget();
    renderStats();
    logActivity('deleted event "' + (e ? e.title : '') + '" — allocation returned to fund');
}

function editEvent(id) { openEventModal(id); }

// ============================================================
// Members
// ============================================================
function renderMembersTable(list) {
    const tbody = document.querySelector('#membersTable tbody');
    const users = list || (appData && appData.users) || [];
    tbody.innerHTML = users.map(function(u) {
        const photo = u.photoURL;
        const initial = esc((u.name || u.email || '?').charAt(0).toUpperCase());
        const avatarHtml = photo
            ? '<img src="' + esc(photo) + '" alt="' + esc(u.name) + '" style="width:28px;height:28px;border-radius:50%;object-fit:cover;flex:none;">'
            : '<span style="width:28px;height:28px;border-radius:50%;background:var(--subtle);color:var(--ink);display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex:none;">' + initial + '</span>';

        const isGoogleAuth = (u.authProvider === 'google.com' || !!u.uid);

        return '<tr>' +
            '<td>' +
                '<div style="display:flex;align-items:center;gap:10px;">' +
                    avatarHtml +
                    '<div>' +
                        '<b>' + esc(u.name) + '</b>' +
                        (isGoogleAuth ? ' <span title="Authenticated via Google" style="display:inline-block;color:#4285F4;font-size:11px;font-weight:bold;margin-left:4px;">&#10003;</span>' : '') +
                    '</div>' +
                '</div>' +
            '</td>' +
            '<td>' + esc(u.email) + '</td>' +
            '<td>' + tag(capitalize(u.role || 'member'), u.role === 'admin' ? 'tag-red' : 'tag-grey') + '</td>' +
            '<td>' + esc(u.department || 'General') + '</td>' +
            '<td>' + statusTag(u.status || 'active') + '</td>' +
            '<td>' + formatDate(u.joinDate) + '</td>' +
            '<td>' + rowActions('Member', u.id) + '</td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="7" class="empty">No members found.</td></tr>';
}

function openMemberModal(id) {
    openModal('memberModal');
    if (id) {
        const m = appData.users.find(function(u) { return u.id === id; });
        document.getElementById('memberModalTitle').textContent = 'Edit member';
        document.getElementById('memberId').value = m.id;
        document.getElementById('memberName').value = m.name;
        document.getElementById('memberEmail').value = m.email;
        document.getElementById('memberRole').value = m.role;
        document.getElementById('memberDepartment').value = m.department;
        document.getElementById('memberStatus').value = m.status;
    } else {
        document.getElementById('memberModalTitle').textContent = 'Add member';
        document.getElementById('memberId').value = '';
        document.getElementById('memberName').value = '';
        document.getElementById('memberEmail').value = '';
        document.getElementById('memberRole').value = 'member';
        document.getElementById('memberDepartment').value = 'Academic';
        document.getElementById('memberStatus').value = 'active';
    }
}

function saveMember() {
    const id = document.getElementById('memberId').value;
    const data = {
        name: val('memberName'),
        email: val('memberEmail'),
        role: val('memberRole'),
        department: val('memberDepartment'),
        status: val('memberStatus')
    };
    if (!data.name || !data.email) {
        alert('Please fill in the name and email.');
        return;
    }
    if (id) {
        const i = appData.users.findIndex(function(u) { return u.id === parseInt(id); });
        appData.users[i] = Object.assign({}, appData.users[i], data);
        logActivity('updated member "' + data.name + '"');
    } else {
        data.id = nextId(appData.users);
        data.joinDate = new Date().toISOString().split('T')[0];
        appData.users.push(data);
        logActivity('added new member "' + data.name + '"');
    }
    saveData();
    closeModal('memberModal');
    renderMembersTable();
    renderStats();
}

function deleteMember(id) {
    const m = appData.users.find(function(u) { return u.id === id; });
    if (!confirm('Remove "' + (m ? m.name : 'this member') + '" from the directory?')) return;
    appData.users = appData.users.filter(function(u) { return u.id !== id; });
    saveData();
    renderMembersTable();
    renderStats();
    logActivity('removed member "' + (m ? m.name : '') + '"');
}

function editMember(id) { openMemberModal(id); }

// ============================================================
// Budget — master fund + event budgets
// The fund is the only pool of money. Creating or editing an
// event's budget REMOVES from the fund's available balance;
// deleting an event budget or reducing one returns money to it.
// ============================================================
function fundTotal() {
    return (appData.fund && typeof appData.fund.total === 'number') ? appData.fund.total : 0;
}

function allocatedTotal() {
    return appData.events.reduce(function(s, e) { return s + (e.allocated || 0); }, 0);
}

function spentTotal() {
    return appData.events.reduce(function(s, e) { return s + (e.spent || 0); }, 0);
}

function unallocatedTotal() {
    return fundTotal() - allocatedTotal();
}

function renderBudget() {
    const total = fundTotal();
    const committed = allocatedTotal();
    const spent = spentTotal();
    const unalloc = total - committed;

    document.getElementById('fundTotal').textContent = 'RM ' + total.toLocaleString();
    document.getElementById('fundCommitted').textContent = 'RM ' + committed.toLocaleString();
    document.getElementById('fundUnallocated').textContent = 'RM ' + unalloc.toLocaleString();
    document.getElementById('fundSpent').textContent = 'RM ' + spent.toLocaleString();
    document.getElementById('budgetEntriesNote').textContent = total === 0
        ? 'No funds added yet — use "Add funds" to start'
        : (unalloc > 0 ? 'RM ' + unalloc.toLocaleString() + ' available to allocate' : 'The fund is fully committed');

    // Stacked fund bar
    const fbar = document.getElementById('fundBar');
    if (fbar) {
        if (total > 0) {
            const spentPct = Math.max(0, Math.min(100, (spent / total) * 100));
            const committedPct = Math.max(0, Math.min(100 - spentPct, (Math.max(0, committed - spent) / total) * 100));
            fbar.innerHTML =
                '<span class="seg-spent" style="width:' + spentPct + '%"></span>' +
                '<span class="seg-committed" style="width:' + committedPct + '%"></span>';
        } else {
            fbar.innerHTML = '';
        }
    }

    // --- event budget cards ---
    const list = document.getElementById('eventBudgetList');
    const events = appData.events.slice().sort(function(a, b) { return new Date(a.date) - new Date(b.date); });

    list.innerHTML = events.map(function(e) {
        const remaining = (e.allocated || 0) - (e.spent || 0);
        const usedPct = e.allocated > 0 ? Math.round(((e.spent || 0) / e.allocated) * 100) : 0;
        const over = remaining < 0;
        const overTag = over ? '<span class="tag tag-red">Over by RM ' + Math.abs(remaining).toLocaleString() + '</span>' : '';
        return '<div class="ecard' + (over ? ' over' : '') + '">' +
            '<div class="ecard-top">' +
                '<div>' +
                    '<h4>' + esc(e.title) + '</h4>' +
                    '<p>' + formatDate(e.date) + ' &middot; ' + esc(capitalize(e.status)) + ' &middot; ' + esc(e.location) + '</p>' +
                '</div>' +
                '<div class="ecard-amt">' + overTag +
                    '<strong>RM ' + (e.allocated || 0).toLocaleString() + '</strong>' +
                    '<span>allocated</span>' +
                '</div>' +
            '</div>' +
            '<div class="ecard-bar">' +
                '<div class="ecard-fill' + (over ? ' over' : '') + '" style="width:' + Math.min(100, usedPct) + '%"></div>' +
            '</div>' +
            '<div class="ecard-meta">' +
                '<span>Spent <b>RM ' + (e.spent || 0).toLocaleString() + '</b></span>' +
                '<span>' + usedPct + '% used</span>' +
                '<span class="' + (over ? 'neg' : '') + '">' + (over ? 'Over' : 'Left') + ' <b>RM ' + Math.abs(remaining).toLocaleString() + '</b></span>' +
            '</div>' +
            '<div class="ecard-actions">' +
                '<button class="btn-edit" onclick="openEventSpendModal(' + e.id + ')">Record expense</button>' +
                '<button class="btn-edit" onclick="openEventBudgetEditModal(' + e.id + ')">Edit budget</button>' +
                '<button class="btn-ghost btn-mini" onclick="showEventLedger(' + e.id + ')">History</button>' +
            '</div>' +
        '</div>';
    }).join('') || '<p class="empty">No events yet — add one in the Events section to budget for it.</p>';
}

function openEventBudgetEditModal(id) {
    const e = appData.events.find(function(x) { return x.id === id; });
    if (!e) return;
    openModal('eventBudgetEditModal');
    document.getElementById('eventBudgetEditId').value = e.id;
    document.getElementById('eventBudgetEditLabel').textContent = e.title;
    document.getElementById('eventBudgetEditCurrent').textContent = 'RM ' + (e.allocated || 0).toLocaleString();
    document.getElementById('eventBudgetEditSpent').textContent = 'RM ' + (e.spent || 0).toLocaleString();
    document.getElementById('eventBudgetEditAllocated').value = e.allocated || 0;
    updateEventBudgetEditPreview();
}

function updateEventBudgetEditPreview() {
    const id = parseInt(document.getElementById('eventBudgetEditId').value);
    const e = appData.events.find(function(x) { return x.id === id; });
    const allocated = parseInt(document.getElementById('eventBudgetEditAllocated').value) || 0;
    const el = document.getElementById('eventBudgetEditPreview');
    if (!e) return;
    const spent = e.spent || 0;
    // reducing this event's allocation returns money to the fund first
    const unallocAfter = unallocatedTotal() + ((e.allocated || 0) - allocated);
    if (allocated < spent) {
        el.textContent = 'This event has already spent RM ' + spent.toLocaleString() + ' — the allocation cannot go below that.';
        el.className = 'formnote warn';
    } else if (unallocAfter < 0) {
        el.textContent = 'Warning: exceeds the fund by RM ' + Math.abs(unallocAfter).toLocaleString() + ' — only RM ' + (unallocatedTotal() + (e.allocated || 0)).toLocaleString() + ' is available for this event.';
        el.className = 'formnote warn';
    } else {
        el.textContent = 'After saving: RM ' + (allocated - spent).toLocaleString() + ' left for this event · RM ' + unallocAfter.toLocaleString() + ' left in the fund' +
            ((e.allocated || 0) !== allocated ? (allocated > (e.allocated || 0) ? ' (taking RM ' + (allocated - (e.allocated || 0)).toLocaleString() + ' more from the fund)' : ' (returning RM ' + ((e.allocated || 0) - allocated).toLocaleString() + ' to the fund)') : '') + '.';
        el.className = 'formnote';
    }
}

function saveEventBudgetEdit() {
    const id = parseInt(document.getElementById('eventBudgetEditId').value);
    const e = appData.events.find(function(x) { return x.id === id; });
    if (!e) return;
    const allocated = parseInt(document.getElementById('eventBudgetEditAllocated').value) || 0;
    const spent = e.spent || 0;

    if (allocated < spent) {
        alert('This event has already spent RM ' + spent.toLocaleString() + '. The allocation cannot be lower than that.');
        return;
    }
    const unallocAfter = unallocatedTotal() + ((e.allocated || 0) - allocated);
    if (unallocAfter < 0) {
        alert('The master fund only has RM ' + (unallocatedTotal() + (e.allocated || 0)).toLocaleString() + ' available for this event (its current allocation returns to the pool first). Lower the amount or add funds.');
        return;
    }

    const diff = allocated - (e.allocated || 0);
    if (diff !== 0) {
        (e.ledger = e.ledger || []).push({
            note: (diff > 0 ? 'Allocation increased — took RM ' + diff.toLocaleString() + ' from the fund' : 'Allocation reduced — returned RM ' + Math.abs(diff).toLocaleString() + ' to the fund') + ' by ' + currentUser().name,
            amount: diff,
            ts: Date.now()
        });
    }
    e.allocated = allocated;
    e.budget = allocated;
    saveData();
    closeModal('eventBudgetEditModal');
    renderBudget();
    renderEventsTable();
    renderStats();
    logActivity('adjusted budget for "' + e.title + '" to RM ' + allocated.toLocaleString());
}

function openEventSpendModal(id) {
    const e = appData.events.find(function(x) { return x.id === id; });
    if (!e) return;
    openModal('eventSpendModal');
    document.getElementById('eventSpendId').value = e.id;
    document.getElementById('eventSpendLabel').textContent = e.title + ' — RM ' + (e.spent || 0).toLocaleString() + ' spent of RM ' + (e.allocated || 0).toLocaleString();
    document.getElementById('eventSpendAmount').value = '';
    document.getElementById('eventSpendNote').value = '';
    updateEventSpendPreview();
}

function updateEventSpendPreview() {
    const id = parseInt(document.getElementById('eventSpendId').value);
    const e = appData.events.find(function(x) { return x.id === id; });
    const amount = parseInt(document.getElementById('eventSpendAmount').value) || 0;
    const el = document.getElementById('eventSpendPreview');
    if (!e) return;
    const after = (e.spent || 0) + amount;
    const remaining = (e.allocated || 0) - after;
    if (remaining < 0) {
        el.textContent = 'Warning: this puts the event RM ' + Math.abs(remaining).toLocaleString() + ' over its allocated budget.';
        el.className = 'formnote warn';
    } else {
        el.textContent = 'After recording: RM ' + after.toLocaleString() + ' spent, RM ' + remaining.toLocaleString() + ' left for this event.';
        el.className = 'formnote';
    }
}

function saveEventSpend() {
    const id = parseInt(document.getElementById('eventSpendId').value);
    const e = appData.events.find(function(x) { return x.id === id; });
    const amount = parseInt(document.getElementById('eventSpendAmount').value) || 0;
    const note = document.getElementById('eventSpendNote').value.trim();

    if (!e) return;
    if (amount <= 0) {
        alert('Enter an amount greater than zero.');
        return;
    }
    e.spent = (e.spent || 0) + amount;
    (e.ledger = e.ledger || []).push({ note: note || 'Expense recorded', amount: -amount, ts: Date.now() });
    saveData();
    closeModal('eventSpendModal');
    renderBudget();
    renderStats();
    logActivity('recorded RM ' + amount.toLocaleString() + ' expense for "' + e.title + '"' + (note ? ' — ' + note : ''));
}

function showEventLedger(id) {
    const e = appData.events.find(function(x) { return x.id === id; });
    if (!e) return;
    openModal('eventLedgerModal');
    document.getElementById('eventLedgerTitle').textContent = 'Budget history — ' + e.title;
    const rows = (e.ledger || []).slice().reverse().map(function(l) {
        const amt = l.amount || 0;
        const cls = amt >= 0 ? 'pos' : 'neg';
        const sign = amt >= 0 ? '+' : '−';
        return '<div class="lgr-row">' +
            '<span class="lgr-amt ' + cls + '">' + sign + 'RM ' + Math.abs(amt).toLocaleString() + '</span>' +
            '<span class="lgr-note">' + esc(l.note || '') + '</span>' +
        '</div>';
    }).join('');
    document.getElementById('eventLedgerBody').innerHTML =
        (rows || '<p class="empty">No history yet.</p>') +
        '<div class="lgr-total"><span>Allocated now</span><b>RM ' + (e.allocated || 0).toLocaleString() + '</b></div>' +
        '<div class="lgr-total"><span>Spent now</span><b>RM ' + (e.spent || 0).toLocaleString() + '</b></div>';
}

// ----- master fund: add funds / edit total -----
function openAddFundsModal() {
    openModal('addFundsModal');
    document.getElementById('fundAddCurrent').textContent = 'RM ' + fundTotal().toLocaleString();
    document.getElementById('fundAddAvailable').textContent = 'RM ' + unallocatedTotal().toLocaleString();
    document.getElementById('fundAddAmount').value = '';
    document.getElementById('fundAddSource').value = '';
    updateAddFundsPreview();
}

function updateAddFundsPreview() {
    const amount = parseInt(document.getElementById('fundAddAmount').value) || 0;
    const el = document.getElementById('fundAddPreview');
    if (amount > 0) {
        el.textContent = 'After adding: fund becomes RM ' + (fundTotal() + amount).toLocaleString() + ', of which RM ' + (unallocatedTotal() + amount).toLocaleString() + ' is available to allocate.';
        el.className = 'formnote';
    } else {
        el.textContent = 'Enter the amount received to see the effect on the fund.';
        el.className = 'formnote';
    }
}

function saveAddFunds() {
    const amount = parseInt(document.getElementById('fundAddAmount').value) || 0;
    const source = document.getElementById('fundAddSource').value.trim();
    if (amount <= 0) {
        alert('Enter an amount greater than zero.');
        return;
    }
    const old = fundTotal();
    appData.fund.total = old + amount;
    (appData.fund.ledger = appData.fund.ledger || []).push({ note: (source ? 'Funds received — ' + source : 'Funds added') + ' by ' + currentUser().name, amount: amount, ts: Date.now() });
    saveData();
    closeModal('addFundsModal');
    renderBudget();
    renderStats();
    logActivity('added RM ' + amount.toLocaleString() + ' to the master fund' + (source ? ' (' + source + ')' : ''));
}

function openEditFundModal() {
    openModal('editFundModal');
    document.getElementById('fundEditCurrent').textContent = 'RM ' + fundTotal().toLocaleString();
    document.getElementById('fundEditCommitted').textContent = 'RM ' + allocatedTotal().toLocaleString();
    document.getElementById('fundEditNew').value = fundTotal();
    updateEditFundPreview();
}

function updateEditFundPreview() {
    const newTotal = parseInt(document.getElementById('fundEditNew').value) || 0;
    const el = document.getElementById('fundEditPreview');
    const unallocAfter = newTotal - allocatedTotal();
    if (unallocAfter < 0) {
        el.textContent = 'Warning: events already hold RM ' + allocatedTotal().toLocaleString() + ' — the fund total cannot go below that.';
        el.className = 'formnote warn';
    } else {
        el.textContent = 'After saving: RM ' + unallocAfter.toLocaleString() + ' available to allocate.';
        el.className = 'formnote';
    }
}

function saveEditFund() {
    const newTotal = parseInt(document.getElementById('fundEditNew').value) || 0;
    if (newTotal <= 0) {
        alert('Enter a valid fund total.');
        return;
    }
    if (newTotal < allocatedTotal()) {
        alert('Events already hold RM ' + allocatedTotal().toLocaleString() + ' in total. The fund total cannot be lower than that.');
        return;
    }
    const old = fundTotal();
    const diff = newTotal - old;
    appData.fund.total = newTotal;
    (appData.fund.ledger = appData.fund.ledger || []).push({ note: 'Fund total edited by ' + currentUser().name, amount: diff, ts: Date.now() });
    saveData();
    closeModal('editFundModal');
    renderBudget();
    renderStats();
    logActivity('edited master fund total from RM ' + old.toLocaleString() + ' to RM ' + newTotal.toLocaleString());
}

// ============================================================
// Documents
// ============================================================
function renderDocuments(list) {
    const grid = document.getElementById('documentsGrid');
    let docs = list || appData.documents.slice();
    if (!list && currentDocumentFilter !== 'all') {
        docs = docs.filter(function(d) { return d.type === currentDocumentFilter; });
    }
    docs.sort(function(a, b) { return new Date(b.date) - new Date(a.date); });

    grid.innerHTML = docs.map(function(d) {
        return '<div class="doc" onclick="viewDocument(' + d.id + ')" title="Click to view">' +
            '<span class="doc-type">' + esc(docTypeLabel(d.type)) + '</span>' +
            '<h4>' + esc(d.title) + '</h4>' +
            '<div class="doc-meta">' +
                '<span>' + formatDate(d.date) + '</span>' +
                '<span>' + esc(d.uploadedBy) + '</span>' +
                '<span>' + esc(d.size || '—') + '</span>' +
            '</div>' +
        '</div>';
    }).join('') || '<p class="empty">No documents filed under this filter.</p>';
}

function docTypeLabel(t) {
    return { minutes: 'Minutes', report: 'Report', proposal: 'Proposal', sop: 'SOP' }[t] || capitalize(t);
}

function filterDocuments(filter) {
    currentDocumentFilter = filter;
    setFilterActive('#documents', filter);
    renderDocuments();
}

function openDocumentModal() {
    openModal('documentModal');
    document.getElementById('docTitle').value = '';
    document.getElementById('docType').value = 'minutes';
    document.getElementById('docCategory').value = 'meeting';
    document.getElementById('docFile').value = '';
}

function saveDocument() {
    const title = val('docTitle');
    if (!title) {
        alert('Please enter a document title.');
        return;
    }
    const fileInput = document.getElementById('docFile');
    const file = fileInput.files[0];
    appData.documents.push({
        id: nextId(appData.documents),
        title: title,
        type: val('docType'),
        category: val('docCategory'),
        date: new Date().toISOString().split('T')[0],
        uploadedBy: currentUser().name,
        size: file ? humanSize(file.size) : '—'
    });
    saveData();
    closeModal('documentModal');
    renderDocuments();
    renderStats();
    logActivity('uploaded document "' + title + '"');
}

function viewDocument(id) {
    const d = appData.documents.find(function(x) { return x.id === id; });
    alert('"' + d.title + '"\n\nFiled by ' + d.uploadedBy + ' on ' + formatDate(d.date) +
        '\n\nFile preview opens here once Firebase Storage is connected.');
}

function humanSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

// ============================================================
// Travel reports
// ============================================================
function renderTravelReports() {
    const tbody = document.querySelector('#travelTable tbody');
    tbody.innerHTML = appData.travelReports.map(function(t) {
        return '<tr>' +
            '<td><b>' + esc(t.member) + '</b></td>' +
            '<td>' + esc(t.event) + '</td>' +
            '<td>' + esc(t.destination) + '</td>' +
            '<td>' + formatDate(t.date) + '</td>' +
            '<td>' + rowActions('TravelReport', t.id) + '</td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="5" class="empty">No travel records yet.</td></tr>';
}

function openTravelModal(id) {
    openModal('travelModal');
    if (id) {
        const t = appData.travelReports.find(function(x) { return x.id === id; });
        document.getElementById('travelModalTitle').textContent = 'Edit travel record';
        document.getElementById('travelId').value = t.id;
        document.getElementById('travelMember').value = t.member;
        document.getElementById('travelEvent').value = t.event;
        document.getElementById('travelDestination').value = t.destination;
        document.getElementById('travelDate').value = t.date;
    } else {
        document.getElementById('travelModalTitle').textContent = 'New travel record';
        document.getElementById('travelId').value = '';
        document.getElementById('travelMember').value = '';
        document.getElementById('travelEvent').value = '';
        document.getElementById('travelDestination').value = '';
        document.getElementById('travelDate').value = '';
    }
}

function saveTravelReport() {
    const id = document.getElementById('travelId').value;
    const data = {
        member: val('travelMember'),
        event: val('travelEvent'),
        destination: val('travelDestination'),
        date: val('travelDate')
    };
    if (!data.member || !data.event) {
        alert('Please fill in the member name and event.');
        return;
    }
    if (id) {
        const i = appData.travelReports.findIndex(function(t) { return t.id === parseInt(id); });
        appData.travelReports[i] = Object.assign({}, appData.travelReports[i], data);
        logActivity('updated travel record for ' + data.member);
    } else {
        data.id = nextId(appData.travelReports);
        appData.travelReports.push(data);
        logActivity('recorded travel for ' + data.member);
    }
    saveData();
    closeModal('travelModal');
    renderTravelReports();
}

function deleteTravelReport(id) {
    if (!confirm('Delete this travel record?')) return;
    appData.travelReports = appData.travelReports.filter(function(t) { return t.id !== id; });
    saveData();
    renderTravelReports();
}

function editTravelReport(id) { openTravelModal(id); }

// ============================================================
// Settings / alerts / search
// ============================================================
function toggleTheme(theme) {
    document.body.classList.toggle('dark', theme === 'dark');
    SafeStorage.set('tcilTheme', theme);
}

function showNotifications() {
    document.getElementById('notificationsPanel').classList.add('show');
    document.getElementById('alertsBackdrop').classList.add('show');
    alertTotal = 0;
    document.getElementById('alertCount').textContent = '0';
}

function closeNotifications() {
    document.getElementById('notificationsPanel').classList.remove('show');
    document.getElementById('alertsBackdrop').classList.remove('show');
}

function handleSearch(query) {
    query = (query || '').trim().toLowerCase();

    if (document.getElementById('events').classList.contains('active')) {
        if (!query) { renderEventsTable(); return; }
        renderEventsTable(appData.events.filter(function(e) {
            return e.title.toLowerCase().indexOf(query) !== -1 ||
                   e.location.toLowerCase().indexOf(query) !== -1;
        }));
    } else if (document.getElementById('members').classList.contains('active')) {
        if (!query) { renderMembersTable(); return; }
        renderMembersTable(appData.users.filter(function(u) {
            return u.name.toLowerCase().indexOf(query) !== -1 ||
                   u.email.toLowerCase().indexOf(query) !== -1;
        }));
    }
}

// Live previews for budget modals
document.addEventListener('DOMContentLoaded', function() {
    const wire = function(ids, fn) {
        ids.forEach(function(id) {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', fn);
        });
    };
    wire(['eventBudgetEditAllocated'], updateEventBudgetEditPreview);
    wire(['eventSpendAmount'], updateEventSpendPreview);
    wire(['fundAddAmount'], updateAddFundsPreview);
    wire(['fundEditNew'], updateEditFundPreview);
});

// ============================================================
// Helpers
// ============================================================
function val(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
}

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function nextId(arr) {
    if (!arr || !arr.length) return 1;
    let max = 0;
    for (let i = 0; i < arr.length; i++) {
        const idNum = parseInt(arr[i] && arr[i].id, 10);
        if (!isNaN(idNum) && idNum > max) {
            max = idNum;
        }
    }
    return max + 1;
}

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.getDate() + ' ' + d.toLocaleString('en', { month: 'short' }) + ' ' + d.getFullYear();
}

function capitalize(s) {
    s = String(s || '');
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function rowActions(kind, id) {
    return '<button class="btn-edit" onclick="edit' + kind + '(' + id + ')">Edit</button>' +
           '<button class="btn-danger" onclick="delete' + kind + '(' + id + ')">Delete</button>';
}

function logActivity(action) {
    if (!appData) return;
    const now = new Date();
    const pad = function(n) { return String(n).padStart(2, '0'); };
    appData.activities.unshift({
        id: nextId(appData.activities),
        user: currentUser().name,
        action: action,
        time: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
              ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()),
        type: 'upload'
    });
    saveData();
    renderRecentActivity();
}

function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) {
    document.getElementById(id).classList.remove('show');
    if (id === 'eventModal') {
        const popover = document.getElementById('timePickerPopover');
        if (popover) popover.style.display = 'none';
    }
}

// Close modal when clicking the dark backdrop
document.addEventListener('click', function(e) {
    if (e.target.classList && e.target.classList.contains('modal')) {
        e.target.classList.remove('show');
        const popover = document.getElementById('timePickerPopover');
        if (popover) popover.style.display = 'none';
    }
});

// ============================================================
// Boot
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('.nav-item').forEach(function(item) {
        item.addEventListener('click', function(e) {
            e.preventDefault();
            navigateTo(this.dataset.section);
        });
    });

    // Restore session
    const savedUser = SafeStorage.get('tcilUser');
    if (savedUser) {
        try {
            setCurrentUser(JSON.parse(savedUser));
            document.getElementById('loginScreen').style.display = 'none';
            document.getElementById('dashboard').style.display = 'flex';
        } catch (e) {
            SafeStorage.remove('tcilUser');
        }
    }

    // Restore theme
    if (SafeStorage.get('tcilTheme') === 'dark') {
        document.body.classList.add('dark');
        const sel = document.getElementById('themeSelect');
        if (sel) sel.value = 'dark';
    }

    loadData();
    initializeApp();
    initFirebase();
    initTimePicker();

    const keyInput = document.getElementById('settingApiKey');
    if (keyInput) {
        const storedKey = SafeStorage.get('tcilApiKey') || ((typeof FIREBASE_CONFIG !== 'undefined') ? FIREBASE_CONFIG.apiKey : '');
        if (storedKey) keyInput.value = storedKey;
    }
});
