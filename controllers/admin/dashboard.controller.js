const { Router } = require('express');
const logger = require('../../utils/logger.js');
const poolPromise = require('../../db');
const { verifyFirebaseToken, isAdmin } = require('../../middleware/auth');

const router = Router();

/**
 * GET /api/admin/dashboard-summary
 * @summary Get aggregated data for the main admin dashboard.
 * @description Retrieves key performance indicators like revenue, station counts, user counts, and data for charts.
 * @tags [Admin]
 * @security
 *   - bearerAuth: []
 * @parameters
 *   - in: query
 *     name: startDate
 *     type: string
 *     description: Filter metrics starting from this date (ISO 8601). Defaults to the start of the current month.
 *   - in: query
 *     name: endDate
 *     type: string
 *     description: Filter metrics ending at this date (ISO 8601). Defaults to now.
 * @responses
 *   200:
 *     description: An object containing all dashboard metrics.
 *     content:
 *       application/json:
 *         schema:
 *           type: object
 *           properties:
 *             revenueByBooth:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   name: { type: string }
 *                   boothUid: { type: string }
 *                   revenue: { type: number }
 *             averageRevenuePerUser:
 *               type: number
 *               description: The average revenue generated per registered user in the selected period.
 *             userGrowth:
 *               type: object
 *               properties:
 *                 newUsers: { type: integer }
 *                 previousPeriodNewUsers: { type: integer }
 *                 growthRate: { type: number, description: "Percentage growth compared to the previous period of the same length." }
 *   500:
 *     description: Internal server error.
 */
router.get('/dashboard-summary', [verifyFirebaseToken, isAdmin], async (req, res) => {
  const pool = await poolPromise;
  const client = await pool.connect();

  const { startDate, endDate } = req.query;
  // Default to start of current month if no startDate provided
  const start = startDate || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const end = endDate || new Date().toISOString();

  try {
    // Define all queries to be run in parallel
    const queries = {
      totalRevenue: `
        SELECT SUM(amount) as "totalRevenue"
        FROM deposits
        WHERE session_type = 'withdrawal' AND status = 'completed' 
        AND completed_at >= $1 AND completed_at <= $2;
      `,
      activeStations: `SELECT COUNT(*) as "activeStations" FROM booths WHERE status = 'online';`,
      totalSwaps: `SELECT COUNT(*) as "totalSwaps" FROM deposits WHERE session_type = 'withdrawal' AND status = 'completed' AND completed_at >= $1 AND completed_at <= $2;`,
      activeSessions: `SELECT COUNT(*) as "activeSessions" FROM deposits WHERE status = 'in_progress';`,
      totalUsers: `SELECT COUNT(*) as "totalUsers" FROM users;`,
      swapVolumeTrend: `
        SELECT
          to_char(day_series, 'Dy') as name,
          COALESCE(swap_count, 0) as val
        FROM
          generate_series(
            date_trunc('day', $1::timestamp),
            date_trunc('day', $2::timestamp),
            '1 day'
          ) as day_series
        LEFT JOIN (
          SELECT date_trunc('day', completed_at) as swap_day, COUNT(*) as swap_count FROM deposits
          WHERE session_type = 'withdrawal' AND status = 'completed' AND completed_at >= $1 AND completed_at <= $2
          GROUP BY swap_day
        ) as swaps ON day_series = swaps.swap_day
        ORDER BY day_series;
      `,
      revenueByBooth: `
        SELECT
          b.name,
          b.booth_uid as "boothUid",
          SUM(d.amount) as "revenue"
        FROM deposits d
        JOIN booths b ON d.booth_id = b.id
        WHERE d.session_type = 'withdrawal' AND d.status = 'completed' 
        AND d.completed_at >= $1 AND d.completed_at <= $2
        GROUP BY b.id, b.name, b.booth_uid
        ORDER BY revenue DESC;
      `,
      newUsersCurrent: `SELECT COUNT(*) as "count" FROM users WHERE created_at >= $1 AND created_at <= $2;`,
      newUsersPrevious: `
        SELECT COUNT(*) as "count" 
        FROM users 
        WHERE created_at >= $1::timestamp - ($2::timestamp - $1::timestamp) 
          AND created_at < $1::timestamp;
      `
    };

    // Execute all queries in parallel for maximum efficiency
    const [
      revenueRes,
      stationsRes,
      swapsRes,
      sessionsRes,
      usersRes,
      trendRes,
      boothRevenueRes,
      newUsersCurrentRes,
      newUsersPreviousRes,
    ] = await Promise.all([
      client.query(queries.totalRevenue, [start, end]),
      client.query(queries.activeStations),
      client.query(queries.totalSwaps, [start, end]),
      client.query(queries.activeSessions),
      client.query(queries.totalUsers),
      client.query(queries.swapVolumeTrend, [start, end]),
      client.query(queries.revenueByBooth, [start, end]),
      client.query(queries.newUsersCurrent, [start, end]),
      client.query(queries.newUsersPrevious, [start, end])
    ]);

    // Consolidate results into a single response object
    const totalRevenue = parseFloat(revenueRes.rows[0]?.totalRevenue || 0);
    const totalUsersCount = parseInt(usersRes.rows[0]?.totalUsers || 0, 10);
    const newUsersCurrent = parseInt(newUsersCurrentRes.rows[0]?.count || 0, 10);
    const newUsersPrevious = parseInt(newUsersPreviousRes.rows[0]?.count || 0, 10);

    const summary = {
      totalRevenue,
      activeStations: parseInt(stationsRes.rows[0]?.activeStations || 0, 10),
      totalSwaps: parseInt(swapsRes.rows[0]?.totalSwaps || 0, 10),
      activeSessions: parseInt(sessionsRes.rows[0]?.activeSessions || 0, 10),
      totalUsers: totalUsersCount,
      averageRevenuePerUser: totalUsersCount > 0 ? parseFloat((totalRevenue / totalUsersCount).toFixed(2)) : 0,
      userGrowth: {
        newUsers: newUsersCurrent,
        previousPeriodNewUsers: newUsersPrevious,
        growthRate: newUsersPrevious > 0 ? parseFloat(((newUsersCurrent - newUsersPrevious) / newUsersPrevious * 100).toFixed(2)) : 0
      },
      swapVolumeTrend: trendRes.rows,
      revenueByBooth: boothRevenueRes.rows.map(row => ({
        ...row,
        revenue: parseFloat(row.revenue || 0)
      })),
      batteryUsage: [], // Return an empty array as this chart is disabled
    };

    res.status(200).json(summary);

  } catch (error) {
    logger.error('Failed to get dashboard summary:', error);
    res.status(500).json({ error: 'Failed to retrieve dashboard summary.', details: error.message });
  } finally {
    client.release();
  }
});

module.exports = router;
