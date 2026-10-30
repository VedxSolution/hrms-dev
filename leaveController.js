// ============================================================
// leaveController.js — Client: Employee Leave Management
// Employees can apply for leave, view history, and check balances.
// ============================================================

const prisma = require('../../shared/config/db');
const { countWorkingDays, fetchPublicHolidayDates, isNonWorkingDay } = require('../../shared/utils/workingDays');
const { getWorkSettings } = require('../../shared/utils/workSettings');
const { SHORT_LEAVE_MONTHLY_LIMIT, monthRange, getLeaveBalances, isLeaveTypeAllowedForEmployeeStatus, effectiveLeaveDays } = require('../../shared/utils/leaveBalance');

// Leave types selectable from the employee-facing Apply Leave dropdown.
// 'Annual Leave' and 'Comp Off' are kept in the DB (existing history/records
// still reference them) but are no longer offered for new applications.
const ALLOWED_APPLY_LEAVE_TYPES = ['Paid Leave', 'Casual Leave', 'Sick Leave', 'Short Leave', 'Unpaid Leave'];

// Sick Leave and Casual Leave are capped at leaveType.daysPerYear per
// calendar YEAR (reset every Jan 1, no carry forward), enforced the same
// way the balance display computes them in leaveBalance.js.
const ANNUAL_CAPPED_TYPES = ['Sick Leave', 'Casual Leave'];

const HALF_SLOTS = ['First Half', 'Second Half'];

// POST /api/client/leaves — apply for leave
async function applyLeave(req, res) {
  try {
    const { employeeId, leaveTypeId, fromDate, toDate, date, halfSlot, reason } = req.body;

    const leaveType = await prisma.leaveType.findUnique({ where: { id: Number(leaveTypeId) } });
    if (!leaveType) {
      return res.status(400).json({ success: false, message: 'Invalid leave type' });
    }
    if (!ALLOWED_APPLY_LEAVE_TYPES.includes(leaveType.name)) {
      return res.status(400).json({ success: false, message: `${leaveType.name} is not available for new leave applications` });
    }

    const empId = Number(employeeId);
    const emp = await prisma.employee.findUnique({ where: { id: empId } });
    if (!emp) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }
    // Authoritative server-side guard: probation employees may only apply for
    // Unpaid Leave, regardless of what the client sends.
    if (!isLeaveTypeAllowedForEmployeeStatus(emp.status, leaveType.name)) {
      return res.status(400).json({ success: false, message: 'Employees on probation can only apply for Unpaid Leave' });
    }

    // ─── Short Leave: single date + First/Second Half, no day-range, 1 hour ──
    if (leaveType.name === 'Short Leave') {
      if (!date || !HALF_SLOTS.includes(halfSlot)) {
        return res.status(400).json({ success: false, message: 'Date and half (First Half / Second Half) are required for Short Leave' });
      }
      const slDate = new Date(date);
      const { workingDaysPerWeek } = await getWorkSettings(prisma);
      const holidayDates = await fetchPublicHolidayDates(prisma, slDate, slDate);
      if (isNonWorkingDay(slDate, workingDaysPerWeek) || holidayDates.size > 0) {
        return res.status(400).json({ success: false, message: 'Selected date is a weekend or holiday' });
      }

      const { start, end } = monthRange(slDate);
      const usedThisMonth = await prisma.leave.count({
        where: {
          employeeId: empId,
          leaveTypeId: leaveType.id,
          status: { not: 'Rejected' },
          fromDate: { gte: start, lte: end },
        },
      });
      if (usedThisMonth >= SHORT_LEAVE_MONTHLY_LIMIT) {
        return res.status(400).json({ success: false, message: `Maximum ${SHORT_LEAVE_MONTHLY_LIMIT} Short Leaves allowed per month` });
      }

      const leave = await prisma.leave.create({
        data: {
          employeeId: empId,
          leaveTypeId: leaveType.id,
          fromDate: slDate,
          toDate: slDate,
          days: 0,
          halfSlot,
          reason: reason || `Short Leave (${halfSlot})`,
          status: 'Pending',
        },
      });

      await prisma.notification.create({
        data: {
          employeeId: null,
          type: 'leave_request',
          message: `${emp.fullName} submitted a Short Leave request (${halfSlot}) for ${slDate.toLocaleDateString('en-IN')}`,
        },
      });

      return res.status(201).json({ success: true, data: leave });
    }

    // ─── Regular date-range leave types ───────────────────────────────────
    const from = new Date(fromDate);
    const to = new Date(toDate);
    if (from > to) {
      return res.status(400).json({ success: false, message: 'From date must be before to date' });
    }

    const holidayDates = await fetchPublicHolidayDates(prisma, from, to);
    const { workingDaysPerWeek } = await getWorkSettings(prisma);
    const days = countWorkingDays(from, to, holidayDates, workingDaysPerWeek);

    if (days === 0) {
      return res.status(400).json({ success: false, message: 'No working days in selected range (weekends/holidays only)' });
    }

    // Select Duration (Full Day / First Half / Second Half): only meaningful
    // for a single-day range. If the range spans more than one day, any
    // half-day selection is ignored server-side and Full Day behaviour
    // applies — matching the frontend, which auto-resets to Full Day.
    let leaveHalfSlot = null;
    if (halfSlot) {
      if (!HALF_SLOTS.includes(halfSlot)) {
        return res.status(400).json({ success: false, message: 'Invalid duration selection' });
      }
      if (from.toDateString() === to.toDateString()) {
        leaveHalfSlot = halfSlot;
      }
    }
    const effectiveDays = effectiveLeaveDays(days, leaveHalfSlot);

    // Sick Leave and Casual Leave are capped at leaveType.daysPerYear per
    // calendar year, matching the balance display exactly (Approved-only,
    // current year).
    if (ANNUAL_CAPPED_TYPES.includes(leaveType.name)) {
      const currentYear = from.getFullYear();
      const rows = await prisma.leave.findMany({
        where: { employeeId: empId, leaveTypeId: leaveType.id, status: 'Approved', fromDate: { gte: new Date(`${currentYear}-01-01`) } },
        select: { days: true, halfSlot: true },
      });
      const usedDays = rows.reduce((sum, r) => sum + effectiveLeaveDays(r.days, r.halfSlot), 0);
      if (usedDays + effectiveDays > leaveType.daysPerYear) {
        return res.status(400).json({ success: false, message: `${leaveType.name} balance exceeded (maximum ${leaveType.daysPerYear} per year)` });
      }
    }

    const leave = await prisma.leave.create({
      data: {
        employeeId: empId,
        leaveTypeId: leaveType.id,
        fromDate: from,
        toDate: to,
        days,
        halfSlot: leaveHalfSlot,
        reason,
        status: 'Pending',
      },
    });

    // Notify admin (employeeId = null means admin notification)
    await prisma.notification.create({
      data: {
        employeeId: null,
        type: 'leave_request',
        message: `${emp.fullName} submitted a leave request for ${effectiveDays} day(s) from ${from.toLocaleDateString('en-IN')}`,
      },
    });

    res.status(201).json({ success: true, data: leave });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// GET /api/client/leaves/:employeeId — get employee's leave history
async function getLeaveHistory(req, res) {
  try {
    const employeeId = Number(req.params.employeeId);
    const leaves = await prisma.leave.findMany({
      where: { employeeId },
      include: { leaveType: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: leaves });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// GET /api/client/leaves/:employeeId/balance — get leave balance per type
async function getLeaveBalance(req, res) {
  try {
    const employeeId = Number(req.params.employeeId);
    const balances = await getLeaveBalances(prisma, employeeId);
    res.json({ success: true, data: balances });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// GET /api/client/leave-types — list leave types selectable for new applications
async function getLeaveTypes(req, res) {
  try {
    const types = await prisma.leaveType.findMany({ where: { name: { in: ALLOWED_APPLY_LEAVE_TYPES } } });
    res.json({ success: true, data: types });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// GET /api/client/holidays — list all holidays
async function getHolidays(req, res) {
  try {
    const holidays = await prisma.holiday.findMany({ orderBy: { date: 'asc' } });
    res.json({ success: true, data: holidays });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { applyLeave, getLeaveHistory, getLeaveBalance, getLeaveTypes, getHolidays };
