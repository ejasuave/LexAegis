#!/usr/bin/env node
import { runCli } from './cli.js';

const controller = new AbortController();
// An interruption cancels any in-flight read; nothing is left running and nothing is retried.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  signal: controller.signal,
});
