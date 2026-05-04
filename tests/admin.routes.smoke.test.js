jest.mock('../db', () =>
  Promise.resolve({
    connect: jest.fn().mockResolvedValue({
      query: jest.fn(),
      release: jest.fn(),
    }),
  })
);

jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  stream: {
    write: jest.fn(),
  },
}));

const adminRouter = require('../routes/admin');

function collectRoutes(router) {
  const routes = [];

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
    { method: 'POST', path: '/booths/:boothUid/reset-slots' },

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

  test('includes exactly the expected admin routes (method + path)', () => {
    const actual = discoveredRoutes
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    const expected = expectedRoutes
      .map((route) => `${route.method} ${route.path}`)
      .sort();

    expect(actual).toEqual(expected);
  });

  test.each(expectedRoutes)(
    '$method $path keeps verifyFirebaseToken and isAdmin middleware',
    ({ method, path }) => {
      const match = discoveredRoutes.find(
        (route) => route.method === method && route.path === path
      );

      expect(match).toBeDefined();
      expect(match.middlewareNames).toContain('verifyFirebaseToken');
      expect(match.middlewareNames).toContain('isAdmin');
    }
  );
});
