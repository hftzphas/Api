const ActivityLog = require('../models/ActivityLog');

async function logActivity(req, action, target = '', detail = '') {
  try {
    await ActivityLog.create({
      actorName: req.user ? req.user.name : '',
      actorRole: req.user ? req.user.role : '',
      action,
      target,
      detail
    });
  } catch (err) {
    console.error('[activityLog] gagal mencatat log:', err.message);
  }
}

module.exports = { logActivity };
