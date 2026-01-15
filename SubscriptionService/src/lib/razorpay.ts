import Razorpay from "razorpay";
import { loadConfig } from "../config";

let razorpayInstance: Razorpay | null = null;

export function getRazorpay(): Razorpay {
    if (!razorpayInstance) {
        const config = loadConfig();
        razorpayInstance = new Razorpay({
            key_id: config.RAZORPAY_KEY_ID,
            key_secret: config.RAZORPAY_KEY_SECRET,
        });
    }
    return razorpayInstance;
}
