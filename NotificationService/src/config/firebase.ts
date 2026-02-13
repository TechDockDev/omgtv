import * as admin from 'firebase-admin';

let firebaseApp: admin.app.App | null = null;

/**
 * Initialize Firebase Admin SDK
 * Credentials are stored as individual environment variables
 */
export function initializeFirebase(): admin.app.App {
    if (admin.apps.length > 0) {
        firebaseApp = admin.apps[0]!;
        return firebaseApp;
    }

    try {
        const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '/app/secrets/firebase/notification-service-account.json';

        // Initialize Firebase Admin
        firebaseApp = admin.initializeApp({
            credential: admin.credential.cert(serviceAccountPath),
        });

        console.log('✅ Firebase Admin SDK initialized successfully');
        return firebaseApp;
    } catch (error) {
        console.error('❌ Failed to initialize Firebase Admin SDK:', error);
        throw new Error(`Firebase initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Get Firebase Messaging instance
 */
export function getMessaging(): admin.messaging.Messaging {
    if (!firebaseApp) {
        throw new Error('Firebase not initialized. Call initializeFirebase() first.');
    }
    return admin.messaging(firebaseApp);
}

/**
 * Get Firebase Admin instance
 */
export function getFirebaseAdmin(): admin.app.App {
    if (!firebaseApp) {
        throw new Error('Firebase not initialized. Call initializeFirebase() first.');
    }
    return firebaseApp;
}
