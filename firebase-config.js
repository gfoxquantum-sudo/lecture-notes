// Real sign-in (Google) and the per-account cloud backup run on this Firebase project.
// These values identify the project; they are not secret. Access is controlled by the
// Firestore security rules (each person can only read and write users/{their uid}/…).
// Set FIREBASE to null to go back to device-only mode with simulated sign-in.

export const FIREBASE = {
  apiKey: 'AIzaSyBHfuU8ocQ3MRsXZTDhCKsAn-nos_8t4Pc',
  authDomain: 'proj-a1df2.firebaseapp.com',
  projectId: 'proj-a1df2',
  storageBucket: 'proj-a1df2.firebasestorage.app',
  messagingSenderId: '121933298281',
  appId: '1:121933298281:web:db44075944ab130c14c0f8',
};
