const { Router } = require('express');

const discoveryRoutes = require('./discovery');
const depositRoutes = require('./deposit');
const withdrawalRoutes = require('./withdrawal');
const supportRoutes = require('./support');

const router = Router();

router.use(discoveryRoutes);
router.use(depositRoutes);
router.use(withdrawalRoutes);
router.use(supportRoutes);

module.exports = router;
