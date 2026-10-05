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
  it("has exactly 60 header columns in the documented order", () => {
    expect(SHEET_HEADER_ROW).toHaveLength(60);
    expect(SHEET_HEADER_ROW[0]).toBe("Submitted At (IST)");
    expect(SHEET_HEADER_ROW[11]).toBe("Lead Photo Link");
    expect(SHEET_HEADER_ROW[57]).toBe("Group PDF Link");
    expect(SHEET_HEADER_ROW[59]).toBe("Consent At (IST)");
  });

  it("formats timestamps as readable IST, e.g. 11 Sep 2026 1:30 PM", () => {
    expect(formatSheetTime(new Date("2026-09-11T08:00:00Z"))).toBe("11 Sep 2026 1:30 PM");
  });

  it("builds a row exactly as wide as the header, with blanks for unused member slots", () => {
    const row = buildDataRow(sampleRow());
    expect(row).toHaveLength(SHEET_HEADER_ROW.length);
    expect(row[0]).toBe("11 Sep 2026 1:30 PM");
    expect(row[1]).toBe("IFF-ABCDEF");
    expect(row[7]).toBe("Rahul Sharma"); // lead name
    expect(row[11]).toBe("https://storage.googleapis.com/b/audience/x.jpg"); // lead photo link
    expect(row[12]).toBe("Priya Sharma"); // member 2 name
    expect(row[16]).toBe(""); // member 2 has no photo
    expect(row[17]).toBe(""); // member 3 unused -> blank
    expect(row[57]).toBe(""); // no group PDF
    expect(row[58]).toBe("v1");
  });
});
