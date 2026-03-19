// Firebase Configuration and Initialization
// Using Firebase v9+ modular SDK

// Import Firebase modules (loaded from CDN in index.html)
// These will be available as global variables: firebase

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDbOyGbfI94fJ7tqRhgzLe7ssGdrwBjsJM",
  authDomain: "adjournal.firebaseapp.com",
  projectId: "adjournal",
  storageBucket: "adjournal.firebasestorage.app",
  messagingSenderId: "1006450008441",
  appId: "1:1006450008441:web:bc96e5e92ea47d8b478fa8"
};

// Initialize Firebase
let app;
let auth;
let db;

function initializeFirebase() {
  // Initialize Firebase app
  app = firebase.initializeApp(firebaseConfig);

  // Initialize Firebase Authentication
  auth = firebase.auth();

  // Initialize Firestore Database
  db = firebase.firestore();

  // Enable offline persistence for Firestore
  db.enablePersistence()
    .catch((err) => {
      if (err.code === 'failed-precondition') {
        console.warn('Persistence failed: Multiple tabs open');
      } else if (err.code === 'unimplemented') {
        console.warn('Persistence not available in this browser');
      }
    });

  console.log('Firebase initialized successfully');
}

// Call initialization when script loads
initializeFirebase();
