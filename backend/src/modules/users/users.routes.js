const router = require('express').Router();
const controller = require('./users.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const upload = require('../../middlewares/upload.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const {
  updateSelfSchema, updateStatusSchema, listQuerySchema,
  updateContactSchema, addressSchema, updateAddressSchema, addressIdParamSchema,
} = require('./users.validation');

router.use(authenticate);

router.get('/me', requirePermission(PERMISSIONS.USERS_READ_SELF), controller.getMe);
router.patch('/me', requirePermission(PERMISSIONS.USERS_UPDATE_SELF), validate({ body: updateSelfSchema }), controller.updateMe);
router.post('/me/avatar', requirePermission(PERMISSIONS.USERS_UPDATE_SELF), upload.single('avatar'), controller.updateAvatar);
router.patch('/me/contact', requirePermission(PERMISSIONS.USERS_UPDATE_SELF), validate({ body: updateContactSchema }), controller.updateContact);

router.get('/me/addresses', requirePermission(PERMISSIONS.USERS_READ_SELF), controller.listAddresses);
router.post('/me/addresses', requirePermission(PERMISSIONS.USERS_UPDATE_SELF), validate({ body: addressSchema }), controller.createAddress);
router.patch('/me/addresses/:id', requirePermission(PERMISSIONS.USERS_UPDATE_SELF), validate({ params: addressIdParamSchema, body: updateAddressSchema }), controller.updateAddress);
router.delete('/me/addresses/:id', requirePermission(PERMISSIONS.USERS_UPDATE_SELF), validate({ params: addressIdParamSchema }), controller.deleteAddress);
router.patch('/me/addresses/:id/default', requirePermission(PERMISSIONS.USERS_UPDATE_SELF), validate({ params: addressIdParamSchema }), controller.setDefaultAddress);

router.get('/', requirePermission(PERMISSIONS.USERS_READ_ANY), validate({ query: listQuerySchema }), controller.list);
router.get('/:id', requirePermission(PERMISSIONS.USERS_READ_ANY), controller.getOne);
// Admin-only: edit any user's profile fields (was previously unwired dead permission). Status changes stay on /:id/status.
router.patch('/:id', requirePermission(PERMISSIONS.USERS_UPDATE_ANY), validate({ body: updateSelfSchema }), controller.updateAny);
router.patch('/:id/status', requirePermission(PERMISSIONS.USERS_BAN), validate({ body: updateStatusSchema }), controller.updateStatus);

module.exports = router;
