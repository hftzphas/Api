const express = require('express');
const router = express.Router();
const ActivityLog = require('../models/ActivityLog');

router.get('/', async (req, res) => {
  try {
    const requested = Number.parseInt(req.query.limit, 10);
    const limit = Math.min(500, Math.max(1, Number.isFinite(requested) ? requested : 100));
    const logs = await ActivityLog.find().sort({ createdAt: -1 }).limit(limit);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
