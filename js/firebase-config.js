// ============================================================
// Firebase Configuration for TCIL Dashboard
// ============================================================
// Project ID: tcil-93af5
// Realtime Database: https://tcil-93af5-default-rtdb.asia-southeast1.firebasedatabase.app

const FIREBASE_CONFIG = {
    apiKey: (function() {
        try {
            return (typeof localStorage !== 'undefined' && localStorage.getItem('tcilApiKey')) || "AIzaSyB5EPikYI6F7knIfiWMVviZPQ6ZfjGMmC4";
        } catch (e) {
            return "AIzaSyB5EPikYI6F7knIfiWMVviZPQ6ZfjGMmC4";
        }
    })(),
    authDomain: "tcil-93af5.firebaseapp.com",
    databaseURL: "https://tcil-93af5-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "tcil-93af5",
    storageBucket: "tcil-93af5.firebasestorage.app"
};
