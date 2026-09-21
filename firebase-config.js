// Paste your Firebase project's web config here (Firebase console > Project
// settings > General > Your apps > SDK setup and configuration > Config).
//
// These values are meant to be public - they identify your project, they
// are not secrets. Security comes from firestore.rules, not from hiding
// this file. It's fine that this is committed to the repo.
//
// Until these are filled in, the site runs in guest-only mode (bets/unit
// size stay in this browser's localStorage, same as before accounts
// existed) - nothing breaks, sign in/up just stays unavailable.
export const firebaseConfig = {
  apiKey: "REPLACE_WITH_YOUR_API_KEY",
  authDomain: "REPLACE_WITH_YOUR_PROJECT.firebaseapp.com",
  projectId: "REPLACE_WITH_YOUR_PROJECT_ID",
  storageBucket: "REPLACE_WITH_YOUR_PROJECT.appspot.com",
  messagingSenderId: "REPLACE_WITH_YOUR_SENDER_ID",
  appId: "REPLACE_WITH_YOUR_APP_ID",
};
