const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  actorName: { type: String, default: '' },
  actorRole: { type: String, default: '' },
  action: { type: String, required: true }, 
  target: { type: String, default: '' }, 
  detail: { type: String, default: '' }
}, { timestamps: true });

activityLogSchema.index({ createdAt: -1 });

module.exports = mongoose.models.ActivityLog || mongoose.model('ActivityLog', activityLogSchema);
