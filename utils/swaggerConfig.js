const fs = require('fs');
const path = require('path');
const swaggerJsdoc = require('swagger-jsdoc');

const projectRoot = path.resolve(__dirname, '..');

const options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'RiderCMS API',
      version: '1.0.0',
      description: 'API documentation for the RiderCMS battery swapping service, providing endpoints for user authentication, booth management, and administrative tasks.',
      contact: {
        name: 'API Support',
        email: 'ridercms@dev.com',
      },
    },
    servers: [
      {
        url: `http://localhost:${process.env.PORT || 8080}`,
        description: 'Development Server',
      },
      // Add your production server URL here when available
      // {
      //   url: 'https://api.ridercms.com',
      //   description: 'Production Server',
      // }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter JWT token in the format: Bearer {token}',
        },
      },
    },
  },
  // Use absolute globs to avoid cwd-dependent discovery issues.
  apis: [
    path.join(projectRoot, 'routes', '*.js'),
    path.join(projectRoot, 'routes', '**', '*.js'),
    path.join(projectRoot, 'controllers', '**', '*.js'),
  ],
};

function parseAdminDocBlock(docBlock) {
  const lines = docBlock
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim());

  const metadata = {
    summary: '',
    description: '',
    tags: ['Admin'],
    security: false,
    responses: {},
    parameters: [],
  };

  let inResponses = false;
  let currentResponseCode = null;
  let inParameters = false;
  let currentParam = null;

  for (const line of lines) {
    if (!line) {
      continue;
    }

    if (line.startsWith('@summary ')) {
      metadata.summary = line.slice('@summary '.length).trim();
      continue;
    }

    if (line.startsWith('@description ')) {
      metadata.description = line.slice('@description '.length).trim();
      continue;
    }

    if (line.startsWith('@tags')) {
      const tagsMatch = line.match(/@tags\s+\[([^\]]+)\]/);
      if (tagsMatch) {
        metadata.tags = tagsMatch[1]
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean);
      }
      continue;
    }

    if (line.includes('bearerAuth')) {
      metadata.security = true;
    }

    if (line.startsWith('@responses')) {
      inResponses = true;
      inParameters = false;
      currentResponseCode = null;
      continue;
    }

    if (line.startsWith('@parameters')) {
      inParameters = true;
      inResponses = false;
      continue;
    }

    if (line.startsWith('@')) {
      inResponses = false;
      inParameters = false;
      currentResponseCode = null;
      continue;
    }

    if (!inResponses) {
      continue;
    }

    const responseCodeMatch = line.match(/^(\d{3}):$/);
    if (responseCodeMatch) {
      currentResponseCode = responseCodeMatch[1];
      if (!metadata.responses[currentResponseCode]) {
        metadata.responses[currentResponseCode] = {
          description: 'No description provided.',
        };
      }
      continue;
    }

    const descriptionMatch = line.match(/^description:\s*(.+)$/i);
    if (descriptionMatch && currentResponseCode) {
      metadata.responses[currentResponseCode] = {
        description: descriptionMatch[1].trim(),
      };
    }

    if (inParameters) {
      if (line.startsWith('-')) {
        currentParam = {};
        metadata.parameters.push(currentParam);
      }

      if (currentParam) {
        const nameMatch = line.match(/name:\s*(.+)$/i);
        const inMatch = line.match(/in:\s*(.+)$/i);
        const descMatch = line.match(/description:\s*(.+)$/i);
        const typeMatch = line.match(/type:\s*(.+)$/i);

        if (nameMatch) currentParam.name = nameMatch[1].trim();
        if (inMatch) currentParam.in = inMatch[1].trim();
        if (descMatch) currentParam.description = descMatch[1].trim();
        if (typeMatch) currentParam.schema = { type: typeMatch[1].trim().replace(/\]/g, '') };
      }
    }
  }

  if (Object.keys(metadata.responses).length === 0) {
    metadata.responses['200'] = { description: 'Success.' };
  }

  return metadata;
}

function toOpenApiPath(routePath) {
  const fullPath = routePath.startsWith('/api/')
    ? routePath
    : `/api/admin${routePath}`;
  return fullPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function getPathParameters(openApiPath) {
  const params = [...openApiPath.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => ({
    in: 'path',
    name: match[1],
    required: true,
    schema: { type: 'string' },
  }));

  return params;
}

function buildAdminPathsFromControllers() {
  const controllersDir = path.join(projectRoot, 'controllers', 'admin');
  if (!fs.existsSync(controllersDir)) {
    return {};
  }

  const routeDocRegex =
    /\/\*\*([\s\S]*?)\*\/\s*router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;

  const paths = {};
  const files = fs
    .readdirSync(controllersDir)
    .filter((file) => file.endsWith('.controller.js'));

  for (const file of files) {
    const filePath = path.join(controllersDir, file);
    const source = fs.readFileSync(filePath, 'utf8');

    let match;
    while ((match = routeDocRegex.exec(source)) !== null) {
      const [, docBlock, method, routePath] = match;
      const openApiPath = toOpenApiPath(routePath);
      const metadata = parseAdminDocBlock(docBlock);

      if (!paths[openApiPath]) {
        paths[openApiPath] = {};
      }

      const operation = {
        tags: metadata.tags.length > 0 ? metadata.tags : ['Admin'],
        responses: metadata.responses,
      };

      if (metadata.summary) {
        operation.summary = metadata.summary;
      }
      if (metadata.description) {
        operation.description = metadata.description;
      }
      if (metadata.security) {
        operation.security = [{ bearerAuth: [] }];
      }
      if (metadata.parameters.length > 0) {
        operation.parameters = metadata.parameters;
      }

      const pathParameters = getPathParameters(openApiPath);
      if (pathParameters.length > 0) {
        operation.parameters = [...(operation.parameters || []), ...pathParameters];
      }

      paths[openApiPath][method.toLowerCase()] = operation;
    }
  }

  return paths;
}

const swaggerSpec = swaggerJsdoc(options);
const adminPaths = buildAdminPathsFromControllers();

swaggerSpec.paths = {
  ...(swaggerSpec.paths || {}),
  ...adminPaths,
};

module.exports = swaggerSpec;
