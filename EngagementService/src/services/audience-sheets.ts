import { loadConfig } from "../config";
import type { NormalizedPerson, NormalizedRegistration } from "../schemas/audience";

// Mirrors every submitted registration as one row in an admin-owned Google
// Sheet, purely for convenience (quick filter/sort/share without opening the
// admin panel). The database stays the source of truth — this is a one-way,
// best-effort copy, never read back by the app.
//
// One row per registration. One name column per person (groups go up to 10,
// enforced by the registration rules), so unused name columns are blank.
// Contacts, emails and photos are stacked one per line in a single cell.
// 'Remarks' is for the team to fill in by hand.
const MAX_GROUP_SIZE = 10;

export const SHEET_HEADER_ROW: string[] = [
  "Timestamp",
  ...Array.from({ length: MAX_GROUP_SIZE }, (_, i) => `FULL NAME ${i + 1} & AGE`),
  "CONTACT NUMBERS OF ALL",
  "EMAIL ID OF ALL",
  "UPLOAD EVERYONE OF YOUR PHOTOS",
  "WHERE ARE YOU FROM",
  "Remarks",
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
  // people is already sorted by position (lead first).
  const nameCells = Array.from({ length: MAX_GROUP_SIZE }, (_, i) => {
    const p = input.people[i];
    return p ? `${p.fullName} – ${p.age}` : "";
  });

  // Photos first; if nobody uploaded one, the group PDF goes in the same cell.
  const photos = input.people
    .map((p) => input.photoLinkByPosition.get(p.position))
    .filter((url): url is string => Boolean(url));
  const photoCell = photos.length > 0 ? photos.join("\n") : (input.groupPdfLink ?? "");

  return [
    formatSheetTime(input.createdAt),
    ...nameCells,
    input.people.map((p) => p.mobile).join("\n"),
    input.people.map((p) => p.email).join("\n"),
    photoCell,
    input.city,
    "", // Remarks: filled in by the team
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
