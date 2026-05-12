#!/usr/bin/env node
import { runServer } from '../lib/image-mcp/server.js';

runServer().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
});
