const router = require('express').Router();
const controller = require('./sellers.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const { applySchema, reviewSchema } = require('./sellers.validation');

router.use(authenticate);
router.post('/apply', requirePermission(PERMISSIONS.SELLER_APPLICATIONS_CREATE), validate({ body: applySchema }), controller.apply);
router.get('/applications/me', controller.me);
router.get('/applications', requirePermission(PERMISSIONS.SELLER_APPLICATIONS_REVIEW), controller.listApplications);
router.patch('/applications/:id/review', requirePermission(PERMISSIONS.SELLER_APPLICATIONS_REVIEW), validate({ body: reviewSchema }), controller.review);

module.exports = router;
