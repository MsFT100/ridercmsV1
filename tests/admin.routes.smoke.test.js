// @ts-ignore
jest.mock('../db', () =>
  Promise.resolve({
    // @ts-ignore
    connect: jest.fn().mockResolvedValue({
      // @ts-ignore
      query: jest.fn(),
      // @ts-ignore
      release: jest.fn(),
    }),
  })
);

// @ts-ignore
jest.mock('../utils/logger', () => ({
  // @ts-ignore
  info: jest.fn(),
  // @ts-ignore
  warn: jest.fn(),
  // @ts-ignore
  error: jest.fn(),
  // @ts-ignore
  debug: jest.fn(),
  stream: {
    // @ts-ignore
    write: jest.fn(),
  },
}));

const adminRouter = require('../routes/admin');

/**
 * Collects all routes from an Express router.
 * @param {import('express').Router} router - The Express router to inspect.
 * @returns {any[]} An array of route objects with method, path, and middlewareNames.
 */
function collectRoutes(router) {
  const routes = [];

  /**
   * Recursively walks the router stack to find all routes.
   * @param {any[]} stack - The router stack.
   */
  function walk(stack) {
    for (const layer of stack) {
      if (layer.route) {
        const path = layer.route.path;
        const methods = Object.keys(layer.route.methods)
          .filter((method) => layer.route.methods[method])
          .map((method) => method.toUpperCase());
        const middlewareNames = layer.route.stack.map(
          (routeLayer) => routeLayer.handle?.name || 'anonymous'
        );

        for (const method of methods) {
          routes.push({ method, path, middlewareNames });
        }
        continue;
      }

      if (layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  }

  walk(router.stack || []);
  return routes;
}

// @ts-ignore
describe('Admin Routes Smoke Test', () => {
  const discoveredRoutes = collectRoutes(adminRouter);

  const expectedRoutes = [
    { method: 'POST', path: '/users/set-role' },
    { method: 'GET', path: '/users' },
    { method: 'POST', path: '/users/set-status' },
    { method: 'DELETE', path: '/users/:uid' },

    { method: 'GET', path: '/booths' },
    { method: 'GET', path: '/booths/status' },
    { method: 'POST', path: '/booths' },
    { method: 'DELETE', path: '/booths/:boothUid' },
    { method: 'DELETE', path: '/booths/:boothUid/slots/:slotIdentifier' },
    { method: 'PATCH', path: '/booths/:boothUid' },
    { method: 'POST', path: '/booths/:boothUid/status' },
    { method: 'POST', path: '/booths/:boothUid/slots/:slotIdentifier/status' },
    { method: 'POST', path: '/booths/:boothUid/slots/:slotIdentifier/command' },
    { method: 'GET', path: '/booths/:boothUid' },
    { method: 'GET', path: '/booths/:boothUid/slots/:slotIdentifier' },
    { method: 'POST', path: '/booths/:boothUid/reset-slots' },
    { method: 'POST', path: '/booths/:boothUid/slots/:slotIdentifier/manual-withdraw' },

    { method: 'GET', path: '/problem-reports' },
    { method: 'POST', path: '/problem-reports/:reportId/status' },

    { method: 'GET', path: '/transactions' },
    { method: 'GET', path: '/settings' },
    { method: 'POST', path: '/settings' },
    { method: 'POST', path: '/simulate/confirm-deposit' },
    { method: 'POST', path: '/simulate/confirm-payment' },
    { method: 'GET', path: '/dashboard-summary' },
    { method: 'GET', path: '/sessions' },
    { method: 'DELETE', path: '/sessions/:sessionId' },
    { method: 'POST', path: '/sessions/cleanup' },
    { method: 'GET', path: '/payments' },
  ];

  // @ts-ignore
  test('includes exactly the expected admin routes (method + path)', () => {
    const actual = discoveredRoutes
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    const expected = expectedRoutes
      .map((route) => `${route.method} ${route.path}`)
      .sort();

    // @ts-ignore
    expect(actual).toEqual(expected);
  });

  // @ts-ignore
  test.each(expectedRoutes)(
    '$method $path keeps verifyFirebaseToken and isAdmin middleware',
    ({ method, path }) => {
      const match = discoveredRoutes.find(
        (route) => route.method === method && route.path === path
      );

      // @ts-ignore
      expect(match).toBeDefined();
      // @ts-ignore
      expect(match.middlewareNames).toContain('verifyFirebaseToken');
      // @ts-ignore
      expect(match.middlewareNames).toContain('isAdmin');
    }
  );
});
