import { describe, expect, it } from "vitest";
import { parseRegistrationPayload } from "../../schemas/audience";
import { AudienceError } from "../../services/audience-errors";
import { csvCell } from "../../utils/csv";
import { sniffFile } from "../../utils/file-sniff";
import { generateReferenceId } from "../../services/audience-registration-service";
import { buildPayload, person } from "./helpers";

function parse(payload: unknown) {
  return parseRegistrationPayload(typeof payload === "string" ? payload : JSON.stringify(payload));
}

function failure(payload: unknown): AudienceError {
  try {
    parse(payload);
  } catch (err) {
    return err as AudienceError;
  }
  throw new Error("expected the payload to be rejected");
}

describe("payload validation", () => {
  it("accepts a valid group and normalizes it", () => {
    const norm = parse(buildPayload(5));
    expect(norm.people).toHaveLength(5);
    expect(norm.people[0].position).toBe(1);
    expect(norm.people[1].email).toBe("person2@example.com"); // lowercased
    expect(norm.city).toBe("Lucknow");
  });

  it("collapses whitespace in names", () => {
    const p = buildPayload(5);
    p.lead.full_name = "  Rahul    Sharma ";
    expect(parse(p).people[0].fullName).toBe("Rahul Sharma");
  });

  it.each([
    ["name too short", (p: any) => (p.lead.full_name = "A"), "lead.full_name"],
    ["name too long", (p: any) => (p.lead.full_name = "A".repeat(81)), "lead.full_name"],
    ["name with markup", (p: any) => (p.lead.full_name = "<b>Evil</b>"), "lead.full_name"],
    ["age zero", (p: any) => (p.lead.age = 0), "lead.age"],
    ["age 100", (p: any) => (p.lead.age = 100), "lead.age"],
    ["age as string", (p: any) => (p.lead.age = "32"), "lead.age"],
    ["age decimal", (p: any) => (p.lead.age = 32.5), "lead.age"],
    ["mobile starts with 5", (p: any) => (p.lead.mobile = "5876543210"), "lead.mobile"],
    ["mobile 9 digits", (p: any) => (p.lead.mobile = "987654321"), "lead.mobile"],
    ["mobile with +91", (p: any) => (p.lead.mobile = "+919876543210"), "lead.mobile"],
    ["bad email", (p: any) => (p.lead.email = "not-an-email"), "lead.email"],
    ["city too short", (p: any) => (p.lead.city = "L"), "lead.city"],
    ["city too long", (p: any) => (p.lead.city = "C".repeat(61)), "lead.city"],
    ["member mobile invalid", (p: any) => (p.members[1].mobile = "12345"), "members[1].mobile"],
    ["member email invalid", (p: any) => (p.members[3].email = "x@"), "members[3].email"],
    ["consent not accepted", (p: any) => (p.consent.accepted = false), "consent.accepted"],
    ["consent timestamp bad", (p: any) => (p.consent.accepted_at = "yesterday"), "consent.accepted_at"],
  ])("rejects: %s", (_name, mutate, field) => {
    const p = buildPayload(5);
    mutate(p);
    const err = failure(p);
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.httpStatus).toBe(422);
    expect(err.fields).toHaveProperty([field]);
  });

  it("reports every invalid field at once with indexed keys", () => {
    const p = buildPayload(5);
    p.members[1].mobile = "12345";
    p.members[3].email = "bad";
    const err = failure(p);
    expect(Object.keys(err.fields!).sort()).toEqual(["members[1].mobile", "members[3].email"]);
  });

  it("rejects non-JSON payloads", () => {
    expect(failure("{not json").fields).toHaveProperty("payload");
  });

  it("accepts the boundaries: age 1 and 99, name length 2 and 80", () => {
    const p = buildPayload(5);
    p.lead.age = 1;
    p.members[0].age = 99;
    p.lead.full_name = "Ab";
    p.members[1].full_name = "N".repeat(80);
    expect(() => parse(p)).not.toThrow();
  });
});

describe("group size", () => {
  it.each([1, 2, 3, 4])("%i people is GROUP_TOO_SMALL (422)", (size) => {
    const err = failure(buildPayload(size));
    expect(err.code).toBe("GROUP_TOO_SMALL");
    expect(err.httpStatus).toBe(422);
  });

  it.each([11, 12])("%i people is GROUP_TOO_LARGE (422)", (size) => {
    const p = buildPayload(size);
    const err = failure(p);
    expect(err.code).toBe("GROUP_TOO_LARGE");
    expect(err.httpStatus).toBe(422);
  });

  it.each([5, 6, 7, 8, 9, 10])("%i people is accepted", (size) => {
    expect(parse(buildPayload(size)).people).toHaveLength(size);
  });

  it("size errors win over field errors", () => {
    const p = buildPayload(4);
    p.lead.mobile = "bad";
    expect(failure(p).code).toBe("GROUP_TOO_SMALL");
  });

  it("rejects non-contiguous or repeated positions", () => {
    const p = buildPayload(5);
    p.members[2].position = 2; // repeats position 2
    const err = failure(p);
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.fields).toHaveProperty(["members[2].position"]);
  });
});

describe("duplicate mobiles inside the group", () => {
  it("flags the repeat with its array index (409)", () => {
    const p = buildPayload(5);
    p.members[2].mobile = p.members[0].mobile;
    const err = failure(p);
    expect(err.code).toBe("DUPLICATE_MOBILE");
    expect(err.httpStatus).toBe(409);
    expect(Object.keys(err.fields!)).toEqual(["members[2].mobile"]);
  });

  it("flags a member that repeats the lead's mobile", () => {
    const p = buildPayload(5);
    p.members[0].mobile = p.lead.mobile;
    expect(Object.keys(failure(p).fields!)).toEqual(["members[0].mobile"]);
  });

  it("keeps original indexes when members arrive out of order", () => {
    const p = buildPayload(5);
    p.members.reverse(); // positions now 5,4,3,2
    p.members[0].mobile = p.lead.mobile; // original index 0 (position 5)
    expect(Object.keys(failure(p).fields!)).toEqual(["members[0].mobile"]);
  });
});

describe("photos_provided", () => {
  it("rejects a photo key outside the group size", () => {
    const err = failure(buildPayload(5, 0, { photos_provided: ["member_9"] }));
    expect(err.fields).toHaveProperty(["photos_provided"]);
  });

  it("rejects unknown photo keys", () => {
    expect(failure(buildPayload(5, 0, { photos_provided: ["member_1"] })).code).toBe("VALIDATION_FAILED");
  });
});

describe("helpers", () => {
  it("generates IFF- references from the safe alphabet", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateReferenceId()).toMatch(/^IFF-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });

  it("detects types by magic bytes, not names", () => {
    expect(sniffFile(Buffer.from("GIF89a....."))).toBeNull();
    expect(sniffFile(Buffer.from("<?php echo 1;"))).toBeNull();
    expect(sniffFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.mime).toBe("image/jpeg");
    expect(sniffFile(Buffer.from("%PDF-1.7"))?.kind).toBe("pdf");
  });

  it("neutralizes spreadsheet formulas in CSV cells", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("+91 98765")).toBe("\"'+91 98765\"");
    expect(csvCell("@cmd")).toBe("\"'@cmd\"");
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell(null)).toBe('""');
  });
});

// keep the person helper referenced so the import is meaningful for readers
void person;
