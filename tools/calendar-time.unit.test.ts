import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addCalendarDays, cohortCalendarDayIndex, cohortDayStart, cohortLocalDate } from "@openmasu/contracts/definitions";

describe("qualified calendar cohort boundaries", () => {
  it("separates UTC Tokyo and New York local dates without a host-zone default", () => {
    const instant = "2026-08-06T23:59:00.000Z";
    assert.equal(cohortLocalDate(instant,"UTC"),"2026-08-06");
    assert.equal(cohortLocalDate(instant,"Asia/Tokyo"),"2026-08-07");
    assert.equal(cohortLocalDate(instant,"America/New_York"),"2026-08-06");
    assert.equal(cohortDayStart("2026-08-07","Asia/Tokyo"),"2026-08-06T15:00:00.000Z");
  });
  it("uses 23-hour spring and 25-hour fall days and counts a repeated hour once per local date", () => {
    const ny = "America/New_York";
    assert.equal(cohortDayStart("2026-03-08",ny),"2026-03-08T05:00:00.000Z");
    assert.equal(cohortDayStart("2026-03-09",ny),"2026-03-09T04:00:00.000Z");
    assert.equal(cohortDayStart("2026-11-01",ny),"2026-11-01T04:00:00.000Z");
    assert.equal(cohortDayStart("2026-11-02",ny),"2026-11-02T05:00:00.000Z");
    for (const instant of ["2026-11-01T05:30:00.000Z","2026-11-01T06:30:00.000Z"])
      assert.equal(cohortCalendarDayIndex("2026-11-01T03:59:00.000Z",instant,ny),1);
  });
  it("crosses month year and leap-day labels and rejects invalid dates and zones", () => {
    assert.equal(addCalendarDays("2026-01-31",1),"2026-02-01");
    assert.equal(addCalendarDays("2026-12-31",1),"2027-01-01");
    assert.equal(addCalendarDays("2028-02-28",1),"2028-02-29");
    assert.throws(()=>addCalendarDays("2026-02-30",1),/calendar_date_invalid/);
    assert.throws(()=>cohortLocalDate(new Date(),"synthetic-zone" as "UTC"),/calendar_time_invalid/);
  });
});
