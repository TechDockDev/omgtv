const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

async function verifyFirebase() {
    process.stdout.write('--- Firebase Verification Script (JS) ---\n');

    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './secrets/firebase/notification-service-account.json';
    const absolutePath = path.resolve(serviceAccountPath);

    process.stdout.write(`Checking service account file at: ${absolutePath}\n`);

    if (!fs.existsSync(absolutePath)) {
        process.stderr.write('❌ Service account file not found!\n');
        process.exit(1);
    }

    try {
        const serviceAccount = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
        process.stdout.write(`Project ID: ${serviceAccount.project_id}\n`);
        process.stdout.write(`Client Email: ${serviceAccount.client_email}\n`);

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });

        process.stdout.write('✅ Firebase Admin SDK initialized successfully\n');

        const messaging = admin.messaging();

        // Testing with the token from logs
        const testToken = 'fiRcPZJMTpOy10jbGrCM0L:APA91bGMBByxfZLpHO7hYjlywD_7QIXLligCJz3jd1dPwCN1-wIe7LamkwKV0LEiHZ9PgbtuVUR8yQ5z4pNiZWKQmrpqoP7_oJ3y9KAfNVIpDhryY7d8ov4';

        process.stdout.write(`\nTesting push to token: ${testToken.substring(0, 20)}...\n`);

        try {
            process.stdout.write('Calling messaging.send (dry run)...\n');
            const response = await messaging.send({
                token: testToken,
                notification: {
                    title: 'Verification Test',
                    body: 'Testing Firebase credentials',
                }
            }, true);

            process.stdout.write(`✅ Dry run successful! Message ID: ${response}\n`);
        } catch (error) {
            process.stdout.write('❌ Push failed:\n');
            process.stdout.write(`Code: ${error.code}\n`);
            process.stdout.write(`Message: ${error.message}\n`);

            if (error.code === 'messaging/mismatched-credential') {
                process.stdout.write('\n⚠️  MISMATCHED CREDENTIAL: The token belongs to a different Firebase project than the one associated with your service account.\n');
            } else if (error.code === 'messaging/invalid-registration-token') {
                process.stdout.write('\n⚠️  INVALID TOKEN: The token is no longer valid or was not generated for this project.\n');
            }
        }

    } catch (error) {
        process.stderr.write(`❌ Unexpected error: ${error.stack || error.message}\n`);
    }
    process.stdout.write('--- Script End ---\n');
    process.exit(0);
}

verifyFirebase();
