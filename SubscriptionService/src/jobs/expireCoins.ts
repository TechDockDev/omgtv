import { CoinService } from "../services/coinService";

interface JobLogger {
    info(obj: object | string, msg?: string): void;
    error(obj: object | string, msg?: string): void;
}

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let timer: ReturnType<typeof setInterval> | null = null;
const coinService = new CoinService();

async function runExpiry(log: JobLogger) {
    try {
        await coinService.expireAllCoins(log);
    } catch (err) {
        log.error({ err }, "expireCoins job failed");
    }
}

export function startExpiryCron(log: JobLogger) {
    if (timer) return;
    void runExpiry(log);
    timer = setInterval(() => void runExpiry(log), INTERVAL_MS);
    log.info("expireCoins cron started (1h interval)");
}

export function stopExpiryCron() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
