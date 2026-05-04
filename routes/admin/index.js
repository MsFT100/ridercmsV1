const { Router } = require('express');

const usersRoutes = require('./users');
const boothsRoutes = require('./booths');
const reportsRoutes = require('./reports');
const transactionsRoutes = require('./transactions');
const settingsRoutes = require('./settings');
const simulationRoutes = require('./simulation');
const dashboardRoutes = require('./dashboard');
const sessionsRoutes = require('./sessions');
const paymentsRoutes = require('./payments');

const router = Router();

router.use(usersRoutes);
router.use(boothsRoutes);
router.use(reportsRoutes);
router.use(transactionsRoutes);
router.use(settingsRoutes);
router.use(simulationRoutes);
router.use(dashboardRoutes);
router.use(sessionsRoutes);
router.use(paymentsRoutes);

module.exports = router;
