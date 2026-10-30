// ============================================================
// dashboardController.js — Client: Employee Dashboard Data
// Returns employee's own stats: attendance, leave balance, notifications.
// ============================================================

const prisma = require('../../shared/config/db');
const { countWorkingDays, fetchPublicHolidayDates, isNonWorkingDay } = require('../../shared/utils/workingDays');
const { getWorkSettings } = require('../../shared/utils/workSettings');
const { getBusinessDate, getBusinessDateParts } = require('../../shared/utils/businessDate');
const { getLeaveBalances } = require('../../shared/utils/leaveBalance');

// GET /api/client/dashboard/:employeeId
async function getDashboardData(req, res) {
  try {
    const employeeId = Number(req.params.employeeId);
    const now = new Date();
    const { year, month } = getBusinessDateParts(now);
    const firstDayOfMonth = new Date(Date.UTC(year, month - 1, 1));
    const lastDayOfMonth = new Date(Date.UTC(year, month, 0));
    const today = getBusinessDate(now);

    // Employee profile
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: { department: true },
    });

    // This month's attendance
    const attendance = await prisma.attendance.findMany({
      where: { employeeId, date: { gte: firstDayOfMonth } },
    });
    const presentDays = attendance.filter((a) => ['Present', 'Late'].includes(a.status)).length;
    const lateDays = attendance.filter((a) => a.status === 'Late').length;

    // Today's attendance record (with all breaks)
    const todayRecord = await prisma.attendance.findUnique({
      where: { employeeId_date: { employeeId, date: today } },
      include: { breaks: { include: { regularization: true }, orderBy: { breakOut: 'asc' } } },
    });

    // Leave balance — Paid Leave is annual, Sick/Casual/Short Leave reset
    // monthly, Unpaid Leave is unlimited. Shared with the balance API and
    // Apply Leave cap validation so all three stay consistent.
    const leaveBalances = await getLeaveBalances(prisma, employeeId, now);

    // All holidays (matching Figma year overview)
    const holidays = await prisma.holiday.findMany({
      orderBy: { date: 'asc' },
    });

    const workSettings = await getWorkSettings(prisma);
    const workingDaysPerWeek = workSettings.workingDaysPerWeek;

    // Week-off days in this month (based on working_days setting)
    let weekOffs = 0;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(Date.UTC(year, month - 1, d));
      if (isNonWorkingDay(date, workingDaysPerWeek)) weekOffs++;
    }

    const holidayDates = await fetchPublicHolidayDates(prisma, firstDayOfMonth, lastDayOfMonth);
    const weekdaysInMonth = countWorkingDays(firstDayOfMonth, lastDayOfMonth, new Set(), workingDaysPerWeek);
    const workingDaysInMonth = countWorkingDays(firstDayOfMonth, lastDayOfMonth, holidayDates, workingDaysPerWeek);
    const publicHolidaysInMonth = holidayDates.size;

    // Latest notifications for this employee
    const notifications = await prisma.notification.findMany({
      where: { employeeId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    res.json({
      success: true,
      data: {
        employee: { id: employee.id, fullName: employee.fullName, empCode: employee.empCode, department: employee.department?.name, designation: employee.designation },
        todayRecord,
        presentDays,
        lateDays,
        leaveBalances,
        weekOffs,
        weekdaysInMonth,
        workingDaysInMonth,
        publicHolidaysInMonth,
        workSettings,
        holidays,
        notifications,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// GET /api/client/notifications/:employeeId — get notifications
async function getNotifications(req, res) {
  try {
    const employeeId = Number(req.params.employeeId);
    const notifs = await prisma.notification.findMany({
      where: { employeeId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    res.json({ success: true, data: notifs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// PATCH /api/client/notifications/:id/read — mark notification as read
async function markRead(req, res) {
  try {
    await prisma.notification.update({ where: { id: Number(req.params.id) }, data: { isRead: true } });
    res.json({ success: true, message: 'Marked as read' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { getDashboardData, getNotifications, markRead };

// Purpose: Provides all data for the employee dashboard in one API call.
// Returns: today's punch status, monthly attendance summary, leave balances, upcoming holidays, notifications.
// Designed so the dashboard page only needs one API call to load completely.
