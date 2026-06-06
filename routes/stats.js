const { Router } = require('express');
const logger = require('../utils/logger');
const poolPromise = require('../db');
const { verifyFirebaseToken } = require('../middleware/auth');

const router = Router();

const MAX_DAYS = 90;
const DEFAULT_DAYS = 7;

/**
 * Parses a value to an integer, returning 0 if invalid.
 * @param {any} value - The value to parse.
 * @returns {number} The parsed integer.
 */
function toInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Parses the 'days' query parameter, enforcing limits.
 * @param {any} value - The raw value from the query string.
 * @returns {number} The validated number of days.
 */
function parseDays(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_DAYS;
  }
  return Math.min(Math.max(parsed, 1), MAX_DAYS);
}

/**
 * Determines the statistics scope (me vs all) based on query and user role.
 * @param {import('express').Request} req - The Express request.
 * @returns {{scope: string}|{error: string}} The scope object or an error message.
 */
function getScope(req) {
  const requestedScope = String(req.query.scope || 'me').toLowerCase();
  const isAdmin = req.user?.role === 'admin';

  if (requestedScope === 'all') {
    if (!isAdmin) {
      return { error: 'Only admin users can request scope=all.' };
    }
    return { scope: 'all' };
  }

  if (requestedScope !== 'me') {
    return { error: "Invalid scope. Use 'me' or 'all'." };
  }

  return { scope: 'me' };
}

/**
 * Validates and normalizes the sessionType query parameter.
 * @param {import('express').Request} req - The Express request.
 * @returns {{sessionType: string}|{error: string}} The sessionType object or an error message.
 */
function getSessionType(req) {
  const rawSessionType = req.query.sessionType;
  if (rawSessionType === undefined) {
    return { sessionType: 'all' };
  }

  const sessionType = String(rawSessionType).toLowerCase();
  if (!['all', 'deposit', 'withdrawal'].includes(sessionType)) {
    return { error: "Invalid sessionType. Use 'all', 'deposit', or 'withdrawal'." };
  }

  return { sessionType };
}

/**
 * Builds SQL WHERE/AND clauses and values for session filtering.
 * @param {object} root0 - Filter parameters.
 * @param {string} root0.scope - 'me' or 'all'.
 * @param {string} root0.sessionType - 'all', 'deposit', or 'withdrawal'.
 * @param {string} root0.uid - The authenticated user's UID.
 * @param {string} [root0.alias] - The table alias in the SQL query.
 * @param {number} [root0.startIndex] - The starting index for SQL parameters ($1, $2, etc.).
 * @returns {{whereClause: string, andClause: string, values: any[]}} The generated SQL clauses and parameters.
 */
function buildFilter({ scope, sessionType, uid, alias = 'd', startIndex = 1 }) {
  const conditions = [];
  const values = [];
  let currentIndex = startIndex;

  if (scope === 'me') {
    conditions.push(`${alias}.user_id = $${currentIndex}`);
    values.push(uid);
    currentIndex += 1;
  }

  if (sessionType !== 'all') {
    conditions.push(`${alias}.session_type = $${currentIndex}`);
    values.push(sessionType);
    currentIndex += 1;
  }

  return {
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    andClause: conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '',
    values,
  };
}

/**
 * GET /api/stats
 * Returns graph-ready session metrics and summary stats.
 *
 * Query params:
 * - scope: 'me' (default) | 'all' (admin only)
 * - sessionType: 'all' (default) | 'deposit' | 'withdrawal'
 * - days: 1..90 (default 7)
 */
router.get('/', verifyFirebaseToken, async (req, res) => {
  const scopeResult = getScope(req);
  if (scopeResult.error) {
    return res.status(403).json({ error: scopeResult.error });
  }

  const sessionTypeResult = getSessionType(req);
  if (sessionTypeResult.error) {
    return res.status(400).json({ error: sessionTypeResult.error });
  }

  const scope = scopeResult.scope;
  const sessionType = sessionTypeResult.sessionType;
  const days = parseDays(req.query.days);
  const uid = req.user.uid;

  const pool = await poolPromise;
  const client = await pool.connect(req.schema);

  try {
    const baseFilter = buildFilter({ scope, sessionType, uid, alias: 'd', startIndex: 1 });

    const summaryQuery = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE d.status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE d.status = 'opening')::int AS opening,
        COUNT(*) FILTER (WHERE d.status = 'in_progress')::int AS "inProgress",
        COUNT(*) FILTER (WHERE d.status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE d.status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE d.status = 'cancelled')::int AS cancelled,
        COUNT(*) FILTER (WHERE d.status = 'redeemed')::int AS redeemed
      FROM deposits d
      ${baseFilter.whereClause};
    `;

    const byStatusQuery = `
      SELECT d.status, COUNT(*)::int AS count
      FROM deposits d
      ${baseFilter.whereClause}
      GROUP BY d.status
      ORDER BY count DESC, d.status ASC;
    `;

    const bySessionTypeQuery = `
      SELECT d.session_type AS "sessionType", COUNT(*)::int AS count
      FROM deposits d
      ${baseFilter.whereClause}
      GROUP BY d.session_type
      ORDER BY d.session_type ASC;
    `;

    const graphFilter = buildFilter({ scope, sessionType, uid, alias: 'd', startIndex: 2 });
    const trendQuery = `
      WITH day_series AS (
        SELECT generate_series(
          date_trunc('day', NOW()) - (($1::int - 1) * interval '1 day'),
          date_trunc('day', NOW()),
          interval '1 day'
        )::date AS day
      )
      SELECT
        to_char(day_series.day, 'YYYY-MM-DD') AS date,
        COALESCE(COUNT(d.id) FILTER (WHERE d.status = 'pending'), 0)::int AS pending,
        COALESCE(COUNT(d.id) FILTER (WHERE d.status = 'completed'), 0)::int AS completed,
        COALESCE(COUNT(d.id) FILTER (WHERE d.status = 'failed'), 0)::int AS failed,
        COALESCE(COUNT(d.id), 0)::int AS total
      FROM day_series
      LEFT JOIN deposits d
        ON d.created_at >= day_series.day
       AND d.created_at < (day_series.day + interval '1 day')
       ${graphFilter.andClause}
      GROUP BY day_series.day
      ORDER BY day_series.day ASC;
    `;

    const [summaryRes, byStatusRes, bySessionTypeRes, trendRes] = await Promise.all([
      client.query(summaryQuery, baseFilter.values),
      client.query(byStatusQuery, baseFilter.values),
      client.query(bySessionTypeQuery, baseFilter.values),
      client.query(trendQuery, [days, ...graphFilter.values]),
    ]);

    const summaryRow = summaryRes.rows[0] || {};
    const summary = {
      total: toInt(summaryRow.total),
      pending: toInt(summaryRow.pending),
      opening: toInt(summaryRow.opening),
      inProgress: toInt(summaryRow.inProgress),
      completed: toInt(summaryRow.completed),
      failed: toInt(summaryRow.failed),
      failure: toInt(summaryRow.failed), // Alias for dashboards expecting "failure".
      cancelled: toInt(summaryRow.cancelled),
      redeemed: toInt(summaryRow.redeemed),
    };

    const byStatus = byStatusRes.rows.map((row) => ({
      status: row.status,
      count: toInt(row.count),
    }));

    const bySessionType = bySessionTypeRes.rows.map((row) => ({
      sessionType: row.sessionType,
      count: toInt(row.count),
    }));

    const trend = trendRes.rows.map((row) => ({
      date: row.date,
      pending: toInt(row.pending),
      completed: toInt(row.completed),
      failed: toInt(row.failed),
      total: toInt(row.total),
    }));

    return res.status(200).json({
      scope,
      sessionType,
      days,
      summary,
      charts: {
        statusTrend: trend,
      },
      breakdown: {
        byStatus,
        bySessionType,
      },
    });
  } catch (error) {
    logger.error('Failed to get stats:', error);
    return res.status(500).json({
      error: 'Failed to retrieve stats.',
      details: error.message,
    });
  } finally {
    client.release();
  }
});

module.exports = router;
