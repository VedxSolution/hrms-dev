// ============================================================
// lateRequestController.js — Client: Employee Late Request Management
// Employees can submit a reason for a "Late" attendance day, edit it
// while it's still Pending, and view their own submission history.
// ============================================================

const prisma = require('../../shared/config/db');

// POST /api/client/late-requests — submit (or resubmit) a late request
async function submitLateRequest(req, res) {
  try {
    const { employeeId, date, reason } = req.body;
    if (!employeeId || !date) {
      return res.status(400).json({ success: false, message: 'Employee and date are required' });
    }

    const empId = Number(employeeId);
    const attDate = new Date(date);

    const attendance = await prisma.attendance.findUnique({
      where: { employeeId_date: { employeeId: empId, date: attDate } },
    });
    if (!attendance || attendance.status !== 'Late') {
      return res.status(400).json({ success: false, message: 'A late request can only be submitted for a day marked Late' });
    }

    const existing = await prisma.lateRequest.findUnique({
      where: { employeeId_date: { employeeId: empId, date: attDate } },
    });
    if (existing && existing.status !== 'Rejected') {
      return res.status(400).json({ success: false, message: `A late request for this date is already ${existing.status.toLowerCase()}` });
    }

    const lateRequest = await prisma.lateRequest.upsert({
      where: { employeeId_date: { employeeId: empId, date: attDate } },
      create: { employeeId: empId, date: attDate, reason, status: 'Pending' },
      update: { reason, status: 'Pending' },
    });

    const emp = await prisma.employee.findUnique({ where: { id: empId } });
    await prisma.notification.create({
      data: {
        employeeId: null,
        type: 'late_request',
        message: `${emp.fullName} submitted a late request for ${attDate.toLocaleDateString('en-IN')}`,
      },
    });

    res.status(201).json({ success: true, data: lateRequest });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// PATCH /api/client/late-requests/:id — edit a late request while it's Pending
async function updateMyLateRequest(req, res) {
  try {
    const { reason } = req.body;
    const existing = await prisma.lateRequest.findUnique({ where: { id: Number(req.params.id) } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Late request not found' });
    }
    if (existing.status !== 'Pending') {
      return res.status(400).json({ success: false, message: 'Only pending late requests can be edited' });
    }

    const updated = await prisma.lateRequest.update({
      where: { id: existing.id },
      data: { reason },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// GET /api/client/late-requests/:employeeId — employee's own late request history
async function getMyLateRequests(req, res) {
  try {
    const employeeId = Number(req.params.employeeId);
    const requests = await prisma.lateRequest.findMany({
      where: { employeeId },
      orderBy: { date: 'desc' },
    });
    res.json({ success: true, data: requests });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { submitLateRequest, updateMyLateRequest, getMyLateRequests };
