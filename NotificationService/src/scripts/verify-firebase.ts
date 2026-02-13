import 'dotenv/config';
import * as admin from 'firebase-admin';
import path from 'path';
import fs from 'fs';

async function verifyFirebase() {
    console.log('--- Firebase Verification Script ---');

    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './secrets/firebase/notification-service-account.json';
    const absolutePath = path.resolve(serviceAccountPath);

    console.log(`Checking service account file at: ${absolutePath}`);

    if (!fs.existsSync(absolutePath)) {
        console.error('❌ Service account file not found!');
        process.exit(1);
    }

    try {
        const serviceAccount = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
        console.log(`Project ID: ${serviceAccount.project_id}`);
        console.log(`Client Email: ${serviceAccount.client_email}`);

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });

        console.log('✅ Firebase Admin SDK initialized successfully');

        const messaging = admin.messaging();

        // Testing with the token from logs
        const testToken = 'fiRcPZJMTpOy10jbGrCM0L:APA91bGMBByxfZLpHO7hYjlywD_7QIXLligCJz3jd1dPwCN1-wIe7LamkwKV0LEiHZ9PgbtuVUR8yQ5z4pNiZWKQmrpqoP7_oJ3y9KAfNVIpDhryY7d8ov4';

        console.log(`\nTesting push to token: ${testToken.substring(0, 20)}...`);

        try {
            const response = await messaging.send({
                token: testToken,
                notification: {
                    title: 'Verification Test',
                    body: 'Testing Firebase credentials',
                },
                android: {
                    priority: 'high',
                }
            }, true); // Dry run enabled

            console.log('✅ Dry run successful! Message ID:', response);
        } catch (error: any) {
            console.error('❌ Push failed:');
            console.error('Code:', error.code);
            console.error('Message:', error.message);

            if (error.code === 'messaging/mismatched-credential') {
                console.error('\n⚠️  MISMATCHED CREDENTIAL: The token belongs to a different Firebase project than the one associated with your service account.');
            } else if (error.code === 'messaging/invalid-registration-token') {
                console.error('\n⚠️  INVALID TOKEN: The token is no longer valid or was not generated for this project.');
            }
        }

    } catch (error: any) {
        console.error('❌ Unexpected error during verification:', error);
    }
}

verifyFirebase().catch(console.error);
