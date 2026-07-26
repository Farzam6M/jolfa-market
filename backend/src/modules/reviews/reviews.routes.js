const router = require('express').Router();
const controller = require('./reviews.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate, optionalAuthenticate } = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const { createSchema, moderateSchema } = require('./reviews.validation');

router.get('/product/:productId', optionalAuthenticate, controller.listForProduct); // public
router.post('/', authenticate, requirePermission(PERMISSIONS.REVIEWS_CREATE), validate({ body: createSchema }), controller.create);
router.delete('/:id', authenticate, requirePermission(PERMISSIONS.REVIEWS_CREATE), controller.remove);
router.patch('/:id/moderate', authenticate, requirePermission(PERMISSIONS.REVIEWS_MODERATE), validate({ body: moderateSchema }), controller.moderate);

module.exports = router;
