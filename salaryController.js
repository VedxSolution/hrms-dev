// ============================================================
// salaryController.js — Client: Employee Salary Slip View
// Employees can view their salary slips and download PDFs.
// ============================================================

const prisma = require('../../shared/config/db');
const { generateSalarySlipPDF } = require('../../shared/services/pdfService');
const { getCompanyInfo, enrichSlipWithCompanyLogo } = require('../../shared/services/payrollService');

// Employee identity is always taken from the authenticated JWT (req.user.id),
// never from the :employeeId URL param — the param is kept for route-shape
// compatibility with the existing frontend but is otherwise ignored.
async function getMySalarySlips(req, res) {
  try {
    const employeeId = Number(req.user.id);
    const [slips, companyInfo] = await Promise.all([
      prisma.salarySlip.findMany({
        where: { employeeId, status: 'Paid' },
        orderBy: [{ year: 'desc' }, { month: 'desc' }, { periodStart: 'desc' }],
      }),
      getCompanyInfo(),
    ]);
    res.json({
      success: true,
      data: slips,
      companyLogo: companyInfo.logo || '',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

async function downloadMySlipPDF(req, res) {
  try {
    const slip = await prisma.salarySlip.findUnique({
      where: { id: Number(req.params.id) },
      include: { employee: { include: { department: true } } },
    });
    if (!slip || slip.status !== 'Paid') {
      return res.status(404).json({ success: false, message: 'Slip not found or not paid' });
    }
    if (slip.employeeId !== Number(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const companyInfo = await getCompanyInfo();
    const slipForPdf = enrichSlipWithCompanyLogo(slip, companyInfo);
    const pdfBuffer = await generateSalarySlipPDF(slipForPdf, slip.employee);
    const periodSlug = (slip.periodType || 'period').replace(/\s+/g, '-');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="salary-slip-${periodSlug}-${slip.year}.pdf"`,
    });
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

async function getPolicies(req, res) {
  try {
    const { category } = req.query;
    const where = category ? { category } : {};
    const policies = await prisma.policy.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json({ success: true, data: policies });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { getMySalarySlips, downloadMySlipPDF, getPolicies };

// Purpose: Lets employees view their own salary slips and download themed PDFs.
// Also exposes the admin-created policies to the employee side as read-only.
// PDF generation uses the same pdfService as the admin side for consistency.
