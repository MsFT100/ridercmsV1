const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'RiderCMS API',
      version: '1.0.0',
      description: 'API documentation for the RiderCMS battery swapping service, providing endpoints for user authentication, booth management, and administrative tasks.',
      contact: {
        name: 'API Support',
        email: 'dev@example.com',
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
  // Path to the API docs
  apis: ['./routes/*.js'],
};

module.exports = swaggerJsdoc(options);