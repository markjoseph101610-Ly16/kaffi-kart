// public/firebase-config.js
// Browser-ready (walang bundler): full CDN URLs ang lahat ng import.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDmirVWGISgdwg2hL-BkKFa5H29ojbDjiQ",
  authDomain: "hello-kaffi-hybrid-d68e1.firebaseapp.com",
  projectId: "hello-kaffi-hybrid-d68e1",
  storageBucket: "hello-kaffi-hybrid-d68e1.firebasestorage.app",
  messagingSenderId: "13465566905",
  appId: "1:13465566905:web:f2deaf06c451b32704a568",
  measurementId: "G-M9GM5TMRKK"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

export {
  app,
  auth,
  googleProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut
};