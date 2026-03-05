
const nodemailer = require('nodemailer');
require('dotenv').config();

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;

console.log("SMTP Config:");
console.log(`Host: ${SMTP_HOST}`);
console.log(`Port: ${SMTP_PORT}`);
console.log(`User: ${SMTP_USER}`);
console.log(`From: ${SMTP_FROM}`);

if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.error("Missing SMTP credentials in .env");
    process.exit(1);
}

const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT),
    secure: parseInt(SMTP_PORT) === 465,
    auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
    },
});

async function testConnection() {
    try {
        console.log("Verifying SMTP connection...");
        await transporter.verify();
        console.log("SMTP connection verified successfully!");

        console.log("Sending test email...");
        const info = await transporter.sendMail({
            from: SMTP_FROM || 'no-reply@omgtv.in',
            to: SMTP_USER, // Send to self
            subject: "SMTP Diagnostic Test",
            text: "If you received this, SMTP is working correctly.",
        });
        console.log("Test email sent successfully:", info.messageId);
    } catch (error) {
        console.error("SMTP Error:", error);
    }
}

testConnection();
