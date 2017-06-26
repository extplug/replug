#!/usr/bin/env node

if (!require('is-async-supported')()) {
  require('async-to-gen/register')
}

require('./src/cli')
