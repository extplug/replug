#!/usr/bin/env node

global.Promise = require('bluebird')

if (!require('is-async-supported')()) {
  require('async-to-gen/register')
}

require('./src/cli')
