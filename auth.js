// Firebase Authentication + per-user profile storage (Firestore).
//
// Degrades gracefully in two ways:
//  1. If firebase-config.js still has placeholder values, we never even
//     fetch the Firebase SDK - isFirebaseReady() resolves false immediately.
//  2. If the Firebase CDN is unreachable for any reason (offline, blocked,
//     outage), the dynamic import below is wrapped in try/catch so that
//     failure can't break the rest of the site the way a static top-level
//     `import` would - it just means accounts stay unavailable and
//     everything else (picks, bets, localStorage) keeps working exactly
//     as it did before accounts existed.
const FIREBASE_SDK_VERSION = "10.14.1";

let auth = null;
let db = null;
let authFns = null;
let firestoreFns = null;
let firebaseReady = false;
let initPromise = null;

async function ensureFirebaseInit() {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const { firebaseConfig } = await import("./firebase-config.js");
        if (!firebaseConfig || !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("REPLACE_")) {
          return; // not configured yet - stay in guest mode, no network calls
        }

        const [{ initializeApp }, authModule, firestoreModule] = await Promise.all([
          import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`),
          import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-auth.js`),
          import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-firestore.js`),
        ]);

        const app = initializeApp(firebaseConfig);
        authFns = authModule;
        firestoreFns = firestoreModule;
        auth = authModule.getAuth(app);
        db = firestoreModule.getFirestore(app);
        firebaseReady = true;
      } catch (err) {
        console.warn("Firebase unavailable — running in guest (localStorage-only) mode.", err);
      }
    })();
  }
  return initPromise;
}

export async function isFirebaseReady() {
  await ensureFirebaseInit();
  return firebaseReady;
}

// callback(user | null) fires once with the current state, then again on
// every sign-in/sign-out.
export async function onAuthChange(callback) {
  await ensureFirebaseInit();
  if (!firebaseReady) {
    callback(null);
    return () => {};
  }
  return authFns.onAuthStateChanged(auth, callback);
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function validUsername(username) {
  return /^[a-z0-9_]{3,20}$/.test(normalizeUsername(username));
}

export async function signUp(username, email, password) {
  await ensureFirebaseInit();
  if (!firebaseReady) throw new Error("Accounts aren't set up yet.");
  if (!validUsername(username)) {
    throw new Error("Usernames must be 3-20 characters: letters, numbers, underscore only.");
  }

  const usernameLower = normalizeUsername(username);
  const cred = await authFns.createUserWithEmailAndPassword(auth, email, password);
  const uid = cred.user.uid;
  const { doc, runTransaction } = firestoreFns;

  try {
    await runTransaction(db, async (tx) => {
      const usernameRef = doc(db, "usernames", usernameLower);
      const existing = await tx.get(usernameRef);
      if (existing.exists()) {
        throw new Error("USERNAME_TAKEN");
      }
      tx.set(usernameRef, { uid });
      tx.set(doc(db, "users", uid), {
        username,
        usernameLower,
        email,
        createdAt: new Date().toISOString(),
      });
      tx.set(doc(db, "profiles", uid), {
        username,
        isPublic: false,
        unitValue: null,
        bets: [],
        updatedAt: new Date().toISOString(),
      });
    });
  } catch (err) {
    // Don't leave an orphaned login with no profile behind - that would
    // permanently block this email from ever signing up again.
    await cred.user.delete().catch(() => {});
    if (err.message === "USERNAME_TAKEN") {
      throw new Error("That username is already taken.");
    }
    throw err;
  }

  return cred.user;
}

export async function signIn(email, password) {
  await ensureFirebaseInit();
  if (!firebaseReady) throw new Error("Accounts aren't set up yet.");
  const cred = await authFns.signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function signOutUser() {
  await ensureFirebaseInit();
  if (!firebaseReady) return;
  await authFns.signOut(auth);
}

export async function getMyProfile(uid) {
  await ensureFirebaseInit();
  if (!firebaseReady) return null;
  const { doc, getDoc } = firestoreFns;
  const snap = await getDoc(doc(db, "profiles", uid));
  return snap.exists() ? snap.data() : null;
}

export async function saveMyProfile(uid, partial) {
  await ensureFirebaseInit();
  if (!firebaseReady) return;
  const { doc, setDoc } = firestoreFns;
  await setDoc(doc(db, "profiles", uid), { ...partial, updatedAt: new Date().toISOString() }, { merge: true });
}
