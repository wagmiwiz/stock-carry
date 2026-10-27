import { expect, test } from "bun:test";
import { inTradingWeek } from "./market-hours";
const at = (iso: string) => inTradingWeek(Date.parse(iso));
test("normal week EDT", () => {
  expect(at("2026-10-19T13:34:00Z")).toBe(false); // Mon 9:34 ET
  expect(at("2026-10-19T13:35:00Z")).toBe(true);  // Mon 9:35 ET
  expect(at("2026-10-21T03:00:00Z")).toBe(true);  // Tue night ET
  expect(at("2026-10-23T19:29:00Z")).toBe(true);  // Fri 15:29 ET
  expect(at("2026-10-23T19:30:00Z")).toBe(false); // Fri 15:30 ET
  expect(at("2026-10-25T15:00:00Z")).toBe(false); // Sun
  expect(at("2026-10-19T03:00:00Z")).toBe(false); // Sun 23:00 ET
});
test("EST after DST", () => {
  expect(at("2026-11-02T14:34:00Z")).toBe(false); // Mon 9:34 EST
  expect(at("2026-11-02T14:35:00Z")).toBe(true);
  expect(at("2026-11-06T20:29:00Z")).toBe(true);  // Fri 15:29 EST
  expect(at("2026-11-06T20:30:00Z")).toBe(false);
});
test("thanksgiving week: early close friday", () => {
  expect(at("2026-11-26T17:00:00Z")).toBe(true);  // Thu holiday, still in week
  expect(at("2026-11-27T17:29:00Z")).toBe(true);  // Fri 12:29 EST
  expect(at("2026-11-27T17:30:00Z")).toBe(false); // Fri 12:30 EST
});
test("christmas week 2026: Fri holiday, Thu early close", () => {
  expect(at("2026-12-24T17:29:00Z")).toBe(true);
  expect(at("2026-12-24T17:30:00Z")).toBe(false);
  expect(at("2026-12-25T15:00:00Z")).toBe(false);
});
test("monday holiday shifts entry to tuesday", () => {
  expect(at("2027-01-18T15:00:00Z")).toBe(false); // MLK
  expect(at("2027-01-19T14:34:00Z")).toBe(false);
  expect(at("2027-01-19T14:35:00Z")).toBe(true);
});
test("good friday 2027: exit thursday", () => {
  expect(at("2027-03-25T19:29:00Z")).toBe(true);  // Thu 15:29 EDT
  expect(at("2027-03-25T19:30:00Z")).toBe(false);
});
