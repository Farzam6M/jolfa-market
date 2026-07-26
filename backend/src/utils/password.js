const bcrypt = require('bcryptjs');
const { bcryptSaltRounds } = require('../config/env');

async function hashPassword(plain) {
  return bcrypt.hash(plain, bcryptSaltRounds);
}

async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

module.exports = { hashPassword, comparePassword };
