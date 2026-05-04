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

const boothsRouter = require('../routes/booths');

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

describe('Booths Routes Smoke Test', () => {
  const discoveredRoutes = collectRoutes(boothsRouter);

  const expectedRoutes = [
    { method: 'GET', path: '/' },
    { method: 'POST', path: '/initiate-deposit' },
    { method: 'GET', path: '/my-battery-status' },
    { method: 'POST', path: '/stop-charging' },
    { method: 'POST', path: '/initiate-withdrawal' },
    { method: 'POST', path: '/sessions/:sessionId/pay' },
    { method: 'GET', path: '/sessions/pending-withdrawal' },
    { method: 'GET', path: '/withdrawal-status/:checkoutRequestId' },
    { method: 'POST', path: '/cancel-session' },
    { method: 'GET', path: '/history' },
    { method: 'POST', path: '/report-problem' },
    { method: 'POST', path: '/release-battery' },
  ];

  test('includes exactly the expected booth routes (method + path)', () => {
    const actual = discoveredRoutes
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    const expected = expectedRoutes
      .map((route) => `${route.method} ${route.path}`)
      .sort();

    expect(actual).toEqual(expected);
  });

  test.each(expectedRoutes)(
    '$method $path keeps verifyFirebaseToken middleware',
    ({ method, path }) => {
      const match = discoveredRoutes.find(
        (route) => route.method === method && route.path === path
      );

      expect(match).toBeDefined();
      expect(match.middlewareNames).toContain('verifyFirebaseToken');
    }
  );
});
