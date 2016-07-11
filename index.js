#!/usr/bin/env node

global.Promise = require('bluebird')

require('./lib/cli')
