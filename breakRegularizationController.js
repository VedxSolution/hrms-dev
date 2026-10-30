// ============================================================
// breakRegularizationController.js — Client: Auto Break Regularization
// Employee requests that a specific Auto Break be treated as working
// time. One request per break, ever — no edits or resubmission once
// the admin decides (mirrors lateRequestController.js's shape, but
// stricter: Late Request allows resubmission after rejection, this
// does not, per the feature spec).
// ============================================================

const prisma = require('../../shared/config/db');

// POST /api/client/attendance/breaks/:breakId/regularization
async function submitRegularization(req, res) {
  try {
    const breakId = Number(req.params.breakId);
    const { employeeId, reason } = req.body;
    const empId = Number(employeeId);

    if (!reason || !reason.trim()) {
      return res.status(400).json({ success: false, message: 'A reason is required' });
    }

    const attendanceBreak = await prisma.attendanceBreak.findUnique({
      where: { id: breakId },
      include: { attendance: true, regularization: true },
    });
    if (!attendanceBreak) {
      return res.status(404).json({ success: false, message: 'Break not found' });
    }
    if (attendanceBreak.attendance.employeeId !== empId) {
      return res.status(403).json({ success: false, message: 'This break does not belong to you' });
    }
    if (attendanceBreak.source !== 'auto') {
      return res.status(400).json({ success: false, message: 'Only automatic breaks can be regularized' });
    }
    if (!attendanceBreak.breakIn) {
      return res.status(400).json({ success: false, message: 'This break has not ended yet' });
    }
    if (attendanceBreak.regularization) {
      return res.status(400).json({ success: false, message: 'A regularization request already exists for this break' });
    }

    const regularization = await prisma.breakRegularization.create({
      data: { attendanceBreakId: breakId, employeeId: empId, reason: reason.trim(), status: 'Pending' },
    });

    const emp = await prisma.employee.findUnique({ where: { id: empId } });
    await prisma.notification.create({
      data: {
        employeeId: null,
        type: 'break_regularization_request',
        message: `${emp.fullName} requested regularization for an automatic break`,
      },
    });

    res.status(201).json({ success: true, data: regularization });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { submitRegularization };
