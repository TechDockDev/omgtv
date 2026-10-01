import { escapeHtml } from "../utils/html";
import { loadConfig } from "../config";

// The banner image URL is set via env. For email clients that block images,
// the template degrades to a coloured header with the show title in text.
function bannerUrl(override?: string | null): string {
  if (override) return override;
  return loadConfig().AUDIENCE_EMAIL_BANNER_URL;
}

// ── Shared layout ──────────────────────────────────────────────────────────

const BASE_STYLE = `
  body { margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  .wrapper { max-width: 600px; margin: 0 auto; background-color: #1a1a1a; border-radius: 12px; overflow: hidden; }
  .banner { width: 100%; display: block; }
  .content { padding: 28px 32px; color: #e0e0e0; line-height: 1.6; }
  .content h2 { color: #ffffff; margin: 0 0 16px 0; font-size: 22px; }
  .content p { margin: 0 0 14px 0; font-size: 15px; }
  .badge { display: inline-block; padding: 6px 18px; border-radius: 20px; font-size: 13px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; }
  .badge-received { background-color: #facc15; color: #1a1a1a; }
  .badge-waitlisted { background-color: #fb923c; color: #1a1a1a; }
  .badge-shortlisted { background-color: #22c55e; color: #ffffff; }
  .badge-not-selected { background-color: #ef4444; color: #ffffff; }
  .detail-table { width: 100%; border-collapse: collapse; margin: 18px 0; }
  .detail-table td { padding: 8px 12px; border-bottom: 1px solid #2a2a2a; font-size: 14px; color: #e0e0e0; }
  .detail-table td:first-child { color: #9ca3af; width: 140px; white-space: nowrap; }
  .footer { padding: 20px 32px; background-color: #111111; text-align: center; color: #6b7280; font-size: 12px; line-height: 1.5; }
  .footer a { color: #facc15; text-decoration: none; }
`;

const BADGE_CLASS: Record<string, string> = {
  RECEIVED: "badge-received",
  WAITLISTED: "badge-waitlisted",
  SHORTLISTED: "badge-shortlisted",
  NOT_SELECTED: "badge-not-selected",
};

const STATUS_LABEL: Record<string, string> = {
  RECEIVED: "Received – Pending Review",
  WAITLISTED: "Waitlisted",
  SHORTLISTED: "Shortlisted ✨",
  NOT_SELECTED: "Not Selected",
};

function statusBadge(status: string): string {
  const cls = BADGE_CLASS[status] ?? "badge-received";
  const label = STATUS_LABEL[status] ?? status;
  return `<span class="${cls}" style="display:inline-block;padding:6px 18px;border-radius:20px;font-size:13px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;">${escapeHtml(label)}</span>`;
}

function layout(body: string, overrideBannerUrl?: string | null): string {
  const banner = bannerUrl(overrideBannerUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Indian Game Show — Audience Registration</title>
  <style>${BASE_STYLE}</style>
</head>
<body style="margin:0;padding:20px 10px;background-color:#0a0a0a;">
  <div class="wrapper" style="max-width:600px;margin:0 auto;background-color:#1a1a1a;border-radius:12px;overflow:hidden;">
    <!-- Banner -->
    <a href="#" style="display:block;background-color:#000000;text-align:center;">
      <img src="${escapeHtml(banner)}" alt="Indian Game Show — Sony LIV × Sony Entertainment Television"
           class="banner" style="width:100%;display:block;max-height:200px;object-fit:cover;" />
    </a>

    <!-- Body -->
    <div class="content" style="padding:28px 32px;color:#e0e0e0;line-height:1.6;">
      ${body}
    </div>

    <!-- Footer -->
    <div class="footer" style="padding:20px 32px;background-color:#111111;text-align:center;color:#6b7280;font-size:12px;line-height:1.5;">
      This email was sent to you because your mobile number is part of an audience registration for the Indian Game Show.<br/>
      If you did not register, please ignore this email.<br/><br/>
      &copy; ${new Date().getFullYear()} Indian Game Show &mdash; Sony Entertainment Television
    </div>
  </div>
</body>
</html>`;
}

function detailRow(label: string, value: string): string {
  return `<tr><td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#9ca3af;width:140px;white-space:nowrap;font-size:14px;">${escapeHtml(label)}</td><td style="padding:8px 12px;border-bottom:1px solid #2a2a2a;color:#e0e0e0;font-size:14px;">${escapeHtml(value)}</td></tr>`;
}

// ── Public interfaces ──────────────────────────────────────────────────────

export interface RegistrationEmailData {
  referenceId: string;
  groupSize: number;
  leadName: string;
  city: string;
  status: string;
  submittedAt: string;
  /** The specific member this email is being sent to. */
  recipientName: string;
  /** "LEAD" or "MEMBER" */
  recipientRole: string;
  bannerImageUrl?: string | null;
}

export interface StatusChangeEmailData {
  referenceId: string;
  groupSize: number;
  leadName: string;
  city: string;
  newStatus: string;
  /** The specific member this email is being sent to. */
  recipientName: string;
  recipientRole: string;
  bannerImageUrl?: string | null;
}

// ── Template: Registration confirmation ────────────────────────────────────

export function buildRegistrationConfirmationHtml(data: RegistrationEmailData): string {
  const isLead = data.recipientRole === "LEAD";
  const greeting = isLead
    ? `Hi ${escapeHtml(data.recipientName)}, your group registration was received!`
    : `Hi ${escapeHtml(data.recipientName)}, you've been registered as part of a group!`;

  const body = `
    <h2 style="color:#ffffff;margin:0 0 16px 0;font-size:22px;">🎬 Registration Received!</h2>
    <p style="margin:0 0 14px 0;font-size:15px;">${greeting}</p>

    <p style="margin:0 0 14px 0;font-size:15px;">
      Your registration is now <strong>pending review</strong>. Once our team reviews and approves your details,
      you will receive an update via email.
    </p>

    <p style="margin:0 0 18px 0;">${statusBadge(data.status)}</p>

    <table style="width:100%;border-collapse:collapse;margin:18px 0;">
      ${detailRow("Reference ID", data.referenceId)}
      ${detailRow("Group Lead", data.leadName)}
      ${detailRow("Group Size", `${data.groupSize} members`)}
      ${detailRow("City", data.city)}
      ${detailRow("Your Role", isLead ? "Group Lead" : "Group Member")}
      ${detailRow("Submitted", data.submittedAt)}
    </table>

    <p style="margin:0 0 14px 0;font-size:15px;color:#9ca3af;">
      Please keep your Reference ID <strong style="color:#facc15;">${escapeHtml(data.referenceId)}</strong> safe.
      You can check your status anytime in the app.
    </p>
  `;
  return layout(body, data.bannerImageUrl);
}

// ── Template: Status change ────────────────────────────────────────────────

const STATUS_MESSAGES: Record<string, { headline: string; message: string }> = {
  RECEIVED: {
    headline: "📋 Registration Under Review",
    message:
      "Your group registration is being reviewed. Our team will evaluate your details and get back to you shortly.",
  },
  WAITLISTED: {
    headline: "⏳ You're on the Waitlist",
    message:
      "Your group has been waitlisted. We will contact you via email if a spot becomes available. Please keep an eye on your inbox!",
  },
  SHORTLISTED: {
    headline: "🎉 Congratulations — You're Shortlisted!",
    message:
      "Great news! Your group has been shortlisted to be part of the live audience. Our team will email you the next steps including the date, venue and reporting instructions.",
  },
  NOT_SELECTED: {
    headline: "Thank You for Registering",
    message:
      "We appreciate your interest, but unfortunately your group was not selected this time. We encourage you to try again for future episodes!",
  },
};

export function buildStatusChangeHtml(data: StatusChangeEmailData): string {
  const info = STATUS_MESSAGES[data.newStatus] ?? STATUS_MESSAGES.RECEIVED;
  const isLead = data.recipientRole === "LEAD";

  const body = `
    <h2 style="color:#ffffff;margin:0 0 16px 0;font-size:22px;">${info.headline}</h2>
    <p style="margin:0 0 14px 0;font-size:15px;">Hi ${escapeHtml(data.recipientName)},</p>

    <p style="margin:0 0 14px 0;font-size:15px;">${info.message}</p>

    <p style="margin:0 0 18px 0;">${statusBadge(data.newStatus)}</p>

    <table style="width:100%;border-collapse:collapse;margin:18px 0;">
      ${detailRow("Reference ID", data.referenceId)}
      ${detailRow("Group Lead", data.leadName)}
      ${detailRow("Group Size", `${data.groupSize} members`)}
      ${detailRow("City", data.city)}
      ${detailRow("Your Role", isLead ? "Group Lead" : "Group Member")}
    </table>

    <p style="margin:0 0 14px 0;font-size:15px;color:#9ca3af;">
      Reference ID: <strong style="color:#facc15;">${escapeHtml(data.referenceId)}</strong>
    </p>
  `;
  return layout(body, data.bannerImageUrl);
}

// ── Subject lines ──────────────────────────────────────────────────────────

export function registrationSubject(referenceId: string): string {
  return `🎬 Registration Received — ${referenceId} | Indian Game Show`;
}

const STATUS_SUBJECTS: Record<string, string> = {
  RECEIVED: "📋 Registration Under Review",
  WAITLISTED: "⏳ Waitlisted",
  SHORTLISTED: "🎉 Congratulations — You're Shortlisted!",
  NOT_SELECTED: "Registration Update",
};

export function statusChangeSubject(referenceId: string, status: string): string {
  const prefix = STATUS_SUBJECTS[status] ?? "Status Update";
  return `${prefix} — ${referenceId} | Indian Game Show`;
}
