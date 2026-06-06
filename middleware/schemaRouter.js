const schemaStorage = require('../utils/schemaStorage');

const schemaRouter = (req, res, next) => {
  req.schema = 'public';
  schemaStorage.run('public', () => next());
};

module.exports = schemaRouter;
