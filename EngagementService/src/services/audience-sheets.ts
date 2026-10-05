import { loadConfig } from "../config";
import type { NormalizedPerson, NormalizedRegistration } from "../schemas/audience";

// Mirrors every submitted registration as one row in an admin-owned Google
// Sheet, purely for convenience (quick filter/sort/share without opening the
// admin panel). The database stays the source of truth — this is a one-way,
// best-effort copy, never read back by the app.
//
// Columns are fixed-width for the max group size (10) so every row has the
// same shape regardless of actual group size; unused member slots are blank.
export const SHEET_HEADER_ROW: string[] = [
  "Submitted At (IST)",
  "Reference ID",
  "Registration ID",
  "Status",
  "Group Size",
  "City",
  "User ID",
  ...Array.from({ length: 10 }, (_, i) => {
    const label = i === 0 ? "Lead" : `Member ${i + 1}`;
    return [`${label} Name`, `${label} Age`, `${label} Mobile`, `${label} Email`, `${label} Photo Link`];
  }).flat(),
  "Group PDF Link",
  "Consent Version",
  "Consent At (IST)",
];

export interface SheetRowInput {
  referenceId: string;
  registrationId: string;
  userId: string | null;
  status: string;
  createdAt: Date;
  groupSize: number;
  city: string;
  people: NormalizedPerson[]; // position 1 (lead) first, then members by position
  consent: NormalizedRegistration["consent"];
  photoLinkByPosition: Map<number, string>; // position -> public URL, only for positions with a stored photo
  groupPdfLink: string | null;
}

export interface RegistrationSheetExporter {
  appendRow(input: SheetRowInput): Promise<void>;
}

// Human-readable IST for the Sheet, e.g. "11 Sep 2026 1:30 PM".
const IST_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

export function formatSheetTime(date: Date): string {
  const parts = Object.fromEntries(IST_PARTS.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.day} ${parts.month} ${parts.year} ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}

export function buildDataRow(input: SheetRowInput): string[] {
  const byPosition = new Map(input.people.map((p) => [p.position, p]));
  const personCells = (position: number): string[] => {
    const p = byPosition.get(position);
    if (!p) return ["", "", "", "", ""];
    return [p.fullName, String(p.age), p.mobile, p.email, input.photoLinkByPosition.get(position) ?? ""];
  };

  return [
    formatSheetTime(input.createdAt),
    input.referenceId,
    input.registrationId,
    input.status,
    String(input.groupSize),
    input.city,
    input.userId ?? "",
    ...Array.from({ length: 10 }, (_, i) => personCells(i + 1)).flat(),
    input.groupPdfLink ?? "",
    input.consent.version,
    formatSheetTime(input.consent.acceptedAt),
  ];
}

// Posts the row to the Apps Script web app attached to the Sheet. The script
// checks the shared secret and appends the row. No GCP project or API involved.
class AppsScriptSheetsExporter implements RegistrationSheetExporter {
  constructor(
    private readonly url: string,
    private readonly secret: string
  ) {}

  async appendRow(input: SheetRowInput): Promise<void> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: this.secret, values: buildDataRow(input) }),
      redirect: "follow",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`sheet webhook responded ${res.status}`);
  }
}

// Default when AUDIENCE_SHEETS_WEBHOOK_URL is unset — the feature is simply off.
class NoopSheetsExporter implements RegistrationSheetExporter {
  async appendRow(): Promise<void> {
    // no-op
  }
}

let cached: RegistrationSheetExporter | undefined;

export function getSheetsExporter(): RegistrationSheetExporter {
  if (cached) return cached;
  const { AUDIENCE_SHEETS_WEBHOOK_URL, AUDIENCE_SHEETS_WEBHOOK_SECRET } = loadConfig();
  cached =
    AUDIENCE_SHEETS_WEBHOOK_URL && AUDIENCE_SHEETS_WEBHOOK_SECRET
      ? new AppsScriptSheetsExporter(AUDIENCE_SHEETS_WEBHOOK_URL, AUDIENCE_SHEETS_WEBHOOK_SECRET)
      : new NoopSheetsExporter();
  return cached;
}

// Test seam.
export function setSheetsExporterForTests(exporter: RegistrationSheetExporter | undefined) {
  cached = exporter;
}
