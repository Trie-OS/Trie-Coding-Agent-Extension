#!/usr/bin/env node
import { runDaemonCli } from './server'

void runDaemonCli(process.argv.slice(2))
