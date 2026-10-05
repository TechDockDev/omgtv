import { describe, expect, it } from "vitest";
import {
  buildDataRow,
  formatSheetTime,
  SHEET_HEADER_ROW,
  type SheetRowInput,
} from "../../services/audience-sheets";

function sampleRow(overrides: Partial<SheetRowInput> = {}): SheetRowInput {
  return {
    referenceId: "IFF-ABCDEF",
    registrationId: "reg-1",
    userId: null,
    status: "RECEIVED",
    createdAt: new Date("2026-09-11T08:00:00Z"), // 1:30 PM IST
    groupSize: 2,
    city: "Lucknow",
    people: [
      { position: 1, memberIndex: null, fullName: "Rahul Sharma", age: 32, mobile: "9876543210", email: "rahul@example.com" },
      { position: 2, memberIndex: 0, fullName: "Priya Sharma", age: 29, mobile: "9876500001", email: "priya@example.com" },
    ],
    consent: { version: "v1", acceptedAt: new Date("2026-09-11T08:00:00Z") },
    photoLinkByPosition: new Map([[1, "https://storage.googleapis.com/b/audience/x.jpg"]]),
    groupPdfLink: null,
    ...overrides,
  };
}

describe("Google Sheet export row", () => {
  it("has exactly 16 header columns in the review-sheet order", () => {
    expect(SHEET_HEADER_ROW).toHaveLength(16);
    expect(SHEET_HEADER_ROW[0]).toBe("Timestamp");
    expect(SHEET_HEADER_ROW[1]).toBe("FULL NAME 1 & AGE");
    expect(SHEET_HEADER_ROW[10]).toBe("FULL NAME 10 & AGE");
    expect(SHEET_HEADER_ROW[11]).toBe("CONTACT NUMBERS OF ALL");
    expect(SHEET_HEADER_ROW[12]).toBe("EMAIL ID OF ALL");
    expect(SHEET_HEADER_ROW[13]).toBe("UPLOAD EVERYONE OF YOUR PHOTOS");
    expect(SHEET_HEADER_ROW[14]).toBe("WHERE ARE YOU FROM");
    expect(SHEET_HEADER_ROW[15]).toBe("Remarks");
  });

  it("formats timestamps as readable IST, e.g. 11 Sep 2026 1:30 PM", () => {
    expect(formatSheetTime(new Date("2026-09-11T08:00:00Z"))).toBe("11 Sep 2026 1:30 PM");
  });

  it("builds a row exactly as wide as the header, with stacked contacts and blank unused name columns", () => {
    const row = buildDataRow(sampleRow());
    expect(row).toHaveLength(SHEET_HEADER_ROW.length);
    expect(row[0]).toBe("11 Sep 2026 1:30 PM");
    expect(row[1]).toBe("Rahul Sharma – 32");
    expect(row[2]).toBe("Priya Sharma – 29");
    expect(row[3]).toBe(""); // person 3 not in this group
    expect(row[10]).toBe(""); // person 10 not in this group
    expect(row[11]).toBe("9876543210\n9876500001"); // all contacts, one per line
    expect(row[12]).toBe("rahul@example.com\npriya@example.com"); // all emails
    expect(row[13]).toBe("https://storage.googleapis.com/b/audience/x.jpg"); // only photo uploaded
    expect(row[14]).toBe("Lucknow");
    expect(row[15]).toBe(""); // Remarks left for the team
  });

  it("puts the group PDF link in the photo column when nobody uploaded a photo", () => {
    const row = buildDataRow(sampleRow({ photoLinkByPosition: new Map(), groupPdfLink: "https://storage.googleapis.com/b/audience/g.pdf" }));
    expect(row[13]).toBe("https://storage.googleapis.com/b/audience/g.pdf");
  });
});
