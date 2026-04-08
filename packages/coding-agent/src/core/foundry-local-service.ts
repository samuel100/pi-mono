#!/usr/bin/env node

/**
 * Foundry Local service launcher.
 *
 * Runs as a long-lived detached process that keeps Foundry Local's
 * embedded web service alive between Pi CLI sessions. Models stay
 * loaded in memory so subsequent Pi invocations avoid cold-start delays.
 *
 * Lifecycle:
 *   1. Pi spawns this script as a detached child process.
 *   2. It initializes FoundryLocalManager and starts the web service.
 *   3. It writes a lockfile with PID + port so Pi can reconnect.
 *   4. It prints a JSON readiness signal to stdout, then stdout is closed by the parent.
 *   5. On SIGTERM / SIGINT / crash, it stops the web service and removes the lockfile.
 *
 * Pi CLI uses:
 *   - SDK (in its own process) for catalog discovery and model download
 *   - HTTP to this service for model load/unload and inference
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FoundryLocalManager } from "foundry-local-sdk";

interface ServiceLockfile {
	pid: number;
	port: number;
	urls: string[];
	startedAt: string;
}

function getLockfilePath(): string {
	return process.argv[2] || "";
}

function writeLockfile(path: string, info: ServiceLockfile): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path, JSON.stringify(info, null, 2), "utf-8");
}

function removeLockfile(path: string): void {
	try {
		if (existsSync(path)) unlinkSync(path);
	} catch {
		// Ignore errors during cleanup
	}
}

function main(): void {
	const lockfilePath = getLockfilePath();
	if (!lockfilePath) {
		process.stderr.write("Usage: foundry-local-service.js <lockfile-path>\n");
		process.exit(1);
	}

	let manager: InstanceType<typeof FoundryLocalManager> | null = null;

	const shutdown = () => {
		if (manager?.isWebServiceRunning) {
			manager.stopWebService();
		}
		removeLockfile(lockfilePath);
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	process.on("uncaughtException", (err) => {
		process.stderr.write(`Foundry Local service crashed: ${err.message}\n`);
		removeLockfile(lockfilePath);
		process.exit(1);
	});
	process.on("unhandledRejection", (reason) => {
		process.stderr.write(`Foundry Local service unhandled rejection: ${reason}\n`);
		removeLockfile(lockfilePath);
		process.exit(1);
	});

	try {
		manager = FoundryLocalManager.create({
			appName: "pi-foundry-local",
			logLevel: "warn",
		});

		manager.startWebService();
		const urls = manager.urls;

		if (urls.length === 0) {
			process.stderr.write("Failed to start web service: no URLs returned\n");
			process.exit(1);
		}

		const url = new URL(urls[0]);
		const port = Number.parseInt(url.port, 10);

		const lockfileData: ServiceLockfile = {
			pid: process.pid,
			port,
			urls,
			startedAt: new Date().toISOString(),
		};

		writeLockfile(lockfilePath, lockfileData);

		// Signal readiness to the parent process via stdout.
		// The parent closes the stdout pipe after reading this.
		process.stdout.write(`${JSON.stringify({ ready: true, ...lockfileData })}\n`);

		// Keep the process alive
		setInterval(() => {}, 30_000);
	} catch (error) {
		process.stderr.write(
			`Failed to start Foundry Local service: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		removeLockfile(lockfilePath);
		process.exit(1);
	}
}

main();
