// ============================================================
// profileController.js — Client Profile Update Requests
// Handles creating requests to update profile info, photo, or documents.
// ============================================================

const prisma = require('../../shared/config/db');

// POST /api/client/profile/update-request
async function createUpdateRequest(req, res) {
  try {
    const employeeId = req.user.id; // From authMiddleware
    const { name, phone, address, emergencyContacts } = req.body;

    // Build the requested data JSON
    const requestedData = JSON.stringify({
      name,
      phone,
      address,
      emergencyContacts: emergencyContacts ? JSON.parse(emergencyContacts) : []
    });

    let photoUrl = null;
    let documentUrl = null;

    if (req.files) {
      if (req.files.photo && req.files.photo.length > 0) {
        const file = req.files.photo[0];
        photoUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
      }
      if (req.files.document && req.files.document.length > 0) {
        const file = req.files.document[0];
        documentUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
      }
    }

    const request = await prisma.profileUpdateRequest.create({
      data: {
        employeeId,
        requestedData,
        photoUrl,
        documentUrl,
        status: 'Pending',
      },
    });

    const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
    await prisma.notification.create({
      data: {
        employeeId: null,
        type: 'profile_update_request',
        message: `${emp.fullName} has requested a profile update.`,
      }
    });

    const mappedRequest = {
      ...request,
      photoUrl: request.photoUrl ? (request.photoUrl.startsWith('data:') ? `/uploads/photos/request-${request.id}.png` : request.photoUrl) : null,
      documentUrl: request.documentUrl ? (request.documentUrl.startsWith('data:') ? `/uploads/documents/request-${request.id}.bin` : request.documentUrl) : null,
    };

    res.json({ success: true, message: 'Update request submitted to admin.', data: mappedRequest });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// GET /api/client/profile/update-requests (Optional: for employee to see their own requests)
async function getMyRequests(req, res) {
  try {
    const employeeId = req.user.id;
    const requests = await prisma.profileUpdateRequest.findMany({
      where: { employeeId },
      orderBy: { createdAt: 'desc' },
    });

    const mappedRequests = requests.map(r => ({
      ...r,
      photoUrl: r.photoUrl ? (r.photoUrl.startsWith('data:') ? `/uploads/photos/request-${r.id}.png` : r.photoUrl) : null,
      documentUrl: r.documentUrl ? (r.documentUrl.startsWith('data:') ? `/uploads/documents/request-${r.id}.bin` : r.documentUrl) : null,
    }));

    res.json({ success: true, data: mappedRequests });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// GET /api/client/profile/password — get current password for profile display
async function getPassword(req, res) {
  try {
    const employee = await prisma.employee.findUnique({
      where: { id: req.user.id },
      select: { plainPassword: true },
    });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }
    res.json({ success: true, data: { password: employee.plainPassword || '' } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// PUT /api/client/profile/password
const bcrypt = require('bcryptjs');

async function updatePassword(req, res) {
  try {
    const employeeId = req.user.id;
    const { newPassword } = req.body;

    if (!newPassword || !String(newPassword).trim()) {
      return res.status(400).json({ success: false, message: 'Password is required' });
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    await prisma.employee.update({
      where: { id: employeeId },
      data: { password: hashedPassword, plainPassword: String(newPassword) }
    });

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { createUpdateRequest, getMyRequests, getPassword, updatePassword };
