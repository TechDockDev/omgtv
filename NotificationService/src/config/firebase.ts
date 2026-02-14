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
        const serviceAccountB64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;

        let credential;

        if (serviceAccountB64) {
            try {
                const buffer = Buffer.from(serviceAccountB64, 'base64');
                const serviceAccount = JSON.parse(buffer.toString('utf8'));
                credential = admin.credential.cert(serviceAccount);
            } catch (e) {
                console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT_B64', e);
                throw e;
            }
        } else {
            credential = admin.credential.cert(serviceAccountPath);
        }

        // Initialize Firebase Admin
        firebaseApp = admin.initializeApp({
            credential,
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
