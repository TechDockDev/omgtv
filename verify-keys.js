const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Read .env manually since we don't have dotenv handy or want to rely on it
const envPath = path.join(__dirname, '.env');
const envContent = fs.readFileSync(envPath, 'utf-8');

const privateKeyMatch = envContent.match(/AUTH_JWT_PRIVATE_KEY="([\s\S]+?)"/);
const publicKeyMatch = envContent.match(/AUTH_JWT_PUBLIC_KEY="([\s\S]+?)"/);

if (!privateKeyMatch || !publicKeyMatch) {
    console.error("Could not find keys in .env");
    process.exit(1);
}

const privateKey = privateKeyMatch[1].replace(/\\n/g, '\n');
const publicKey = publicKeyMatch[1].replace(/\\n/g, '\n');

console.log("Checking keys...");

const data = "test-data-to-sign";

try {
    const sign = crypto.createSign('SHA256');
    sign.update(data);
    sign.end();
    const signature = sign.sign(privateKey);

    const verify = crypto.createVerify('SHA256');
    verify.update(data);
    verify.end();
    const isValid = verify.verify(publicKey, signature);

    console.log("Key Pair Valid:", isValid);
} catch (e) {
    console.error("Error verifying keys:", e.message);
}
