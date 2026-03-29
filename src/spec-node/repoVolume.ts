/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { LogLevel, makeLog, createPlainLog, Log } from '../spec-utils/log';
import { dockerCLI, PartialExecParameters } from '../spec-shutdown/dockerUtils';
import { getCLIHost, loadNativeModule } from '../spec-common/commonUtils';

// ── Naming conventions ────────────────────────────────────────────────────────
//  Volumes:    <prefix>-vol-YYMMDD-NN   (e.g. myproj-vol-260325-01)
//  Containers: <prefix>-ctr-YYMMDD-NN   (e.g. myproj-ctr-260325-01)
//
//  References accepted by --from-vol, --with-vol, etc.:
//    "my-exact-name"        → literal name
//    "foo@latest"           → most recent foo-{vol|ctr}-*
//    "foo@260325-01"        → foo-{vol|ctr}-260325-01
//    "foo@-1"               → keep-1 / previous-to-latest (context dependent)

const MANAGED_NAME_RE = /^(.+)-(vol|ctr)-(\d{6})-(\d{2})$/;

function formatDate(date = new Date()): string {
	const yy = String(date.getFullYear()).slice(-2);
	const mm = String(date.getMonth() + 1).padStart(2, '0');
	const dd = String(date.getDate()).padStart(2, '0');
	return `${yy}${mm}${dd}`;
}

function parseManagedName(name: string) {
	const m = MANAGED_NAME_RE.exec(name);
	if (!m) {
		return undefined;
	}
	return { prefix: m[1], type: m[2] as 'vol' | 'ctr', date: m[3], seq: m[4] };
}

// ── Listing ───────────────────────────────────────────────────────────────────

async function listVolumes(params: PartialExecParameters): Promise<string[]> {
	const result = await dockerCLI(params, 'volume', 'ls', '--format', '{{.Name}}');
	return result.stdout.toString().trim().split('\n').filter(Boolean);
}

async function listContainers(params: PartialExecParameters): Promise<string[]> {
	const result = await dockerCLI(params, 'ps', '-a', '--format', '{{.Names}}');
	return result.stdout.toString().trim().split('\n').filter(Boolean);
}

function filterByPrefixAndType(names: string[], prefix: string, type: 'vol' | 'ctr'): string[] {
	const pat = `${prefix}-${type}-`;
	return names.filter(n => n.startsWith(pat)).sort();
}

// ── Name generation ───────────────────────────────────────────────────────────

export async function generateVolumeName(params: PartialExecParameters, prefix: string): Promise<string> {
	const all = await listVolumes(params);
	return generateManagedName(all, prefix, 'vol');
}

export async function generateContainerName(params: PartialExecParameters, prefix: string): Promise<string> {
	const all = await listContainers(params);
	return generateManagedName(all, prefix, 'ctr');
}

function generateManagedName(existing: string[], prefix: string, type: 'vol' | 'ctr'): string {
	const today = formatDate();
	const dayPrefix = `${prefix}-${type}-${today}-`;
	const todayNames = existing.filter(n => n.startsWith(dayPrefix));
	const maxSeq = todayNames.reduce((max, name) => {
		const seq = parseInt(name.slice(dayPrefix.length), 10);
		return isNaN(seq) ? max : Math.max(max, seq);
	}, 0);
	const next = String(maxSeq + 1).padStart(2, '0');
	return `${dayPrefix}${next}`;
}

// ── Reference resolution ──────────────────────────────────────────────────────
//
//  "my-exact-name"   → "my-exact-name"
//  "foo@latest"      → latest foo-{type}-*
//  "foo@260325-01"   → "foo-{type}-260325-01"
//  "foo@-1"          → second-from-end in sorted list (= previous)

export async function resolveVolumeRef(params: PartialExecParameters, ref: string): Promise<string> {
	return resolveRef(await listVolumes(params), ref, 'vol');
}

export async function resolveContainerRef(params: PartialExecParameters, ref: string): Promise<string> {
	return resolveRef(await listContainers(params), ref, 'ctr');
}

function resolveRef(allNames: string[], ref: string, type: 'vol' | 'ctr'): string {
	const atIdx = ref.indexOf('@');
	if (atIdx === -1) {
		return ref; // explicit name, use as-is
	}
	const prefix = ref.slice(0, atIdx);
	const selector = ref.slice(atIdx + 1);
	const matching = filterByPrefixAndType(allNames, prefix, type);

	if (!matching.length) {
		throw new Error(`No ${type === 'vol' ? 'volumes' : 'containers'} found matching prefix '${prefix}'.`);
	}

	if (selector === 'latest') {
		return matching[matching.length - 1];
	}

	if (/^-\d+$/.test(selector)) {
		const offset = parseInt(selector, 10); // negative
		const index = matching.length + offset;
		if (index < 0 || index >= matching.length) {
			throw new Error(`Offset ${selector} is out of range (${matching.length} items matching '${prefix}-${type}-*').`);
		}
		return matching[index];
	}

	// Treat as date-seq suffix, e.g. "260325-01"
	const explicit = `${prefix}-${type}-${selector}`;
	if (matching.includes(explicit)) {
		return explicit;
	}
	throw new Error(`${type === 'vol' ? 'Volume' : 'Container'} '${explicit}' not found.`);
}

// ── Fallback auto-name (hash-based, for backward compat with --repository) ───

export function getAutoVolumeName(repoUrl: string): string {
	const hash = crypto.createHash('sha256').update(repoUrl).digest('hex').substring(0, 12);
	const repoName = repoUrl
		.replace(/\.git$/, '')
		.split(/[/:]+/)
		.pop() || 'repo';
	const sanitized = repoName.replace(/[^a-zA-Z0-9_.-]/g, '-').toLowerCase();
	return `devcontainer-${sanitized}-${hash}`;
}

export function getRepoBasename(repoUrl: string): string {
	return repoUrl.replace(/\.git$/, '').split(/[/:]+/).pop() || 'repo';
}

// ── Volume labels ─────────────────────────────────────────────────────────────

const LABEL_REPO_BASENAME = 'devcontainer.repo-basename';

async function getVolumeLabel(params: PartialExecParameters, volumeName: string, label: string): Promise<string | undefined> {
	try {
		const result = await dockerCLI(params, 'volume', 'inspect', volumeName, '--format', `{{index .Labels "${label}"}}`);
		const val = result.stdout.toString().trim();
		return val && val !== '<no value>' ? val : undefined;
	} catch {
		return undefined;
	}
}

async function getVolumeLabels(params: PartialExecParameters, volumeName: string): Promise<Record<string, string>> {
	try {
		const result = await dockerCLI(params, 'volume', 'inspect', volumeName, '--format', '{{json .Labels}}');
		const raw = result.stdout.toString().trim();
		if (!raw || raw === 'null' || raw === '{}') {
			return {};
		}
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

// ── Volume operations ─────────────────────────────────────────────────────────

export async function createVolume(params: PartialExecParameters, name: string, labels?: Record<string, string>): Promise<void> {
	const args = ['volume', 'create'];
	if (labels) {
		for (const [k, v] of Object.entries(labels)) {
			args.push('--label', `${k}=${v}`);
		}
	}
	args.push(name);
	await dockerCLI(params, ...args);
}

export async function removeVolume(params: PartialExecParameters, name: string): Promise<void> {
	await dockerCLI(params, 'volume', 'rm', name);
}

export async function cloneVolume(params: PartialExecParameters, source: string, dest: string): Promise<void> {
	params.output.write(`Cloning volume '${source}' → '${dest}'...`);
	const sourceLabels = await getVolumeLabels(params, source);
	await createVolume(params, dest, sourceLabels);
	await dockerCLI(params, 'run', '--rm',
		'-v', `${source}:/src:ro`,
		'-v', `${dest}:/dest`,
		'alpine', 'sh', '-c', 'cp -a /src/. /dest/ && chown -R 1000:1000 /dest/',
	);
}

async function volumeHasContent(params: PartialExecParameters, name: string): Promise<boolean> {
	try {
		await dockerCLI(params, 'volume', 'inspect', name);
		const result = await dockerCLI(params, 'run', '--rm',
			'-v', `${name}:/workspace`,
			'alpine', 'sh', '-c', 'ls -A /workspace | head -1',
		);
		return result.stdout.toString().trim().length > 0;
	} catch {
		return false;
	}
}

// ── Container operations ──────────────────────────────────────────────────────

export async function removeContainerForce(params: PartialExecParameters, name: string): Promise<void> {
	await dockerCLI(params, 'rm', '-f', name);
}

// ── Repo cloning into volume ──────────────────────────────────────────────────

export async function cloneRepoIntoVolume(
	params: PartialExecParameters,
	volumeName: string,
	repoUrl: string,
	ref?: string,
): Promise<void> {
	const { output, env } = params;

	const hasContent = await volumeHasContent(params, volumeName);
	if (hasContent) {
		output.write(`Volume '${volumeName}' already has content, skipping clone.`);
		return;
	}

	output.write(`Cloning ${repoUrl}${ref ? ` (ref: ${ref})` : ''} into volume '${volumeName}'...`);

	const runArgs = ['run', '--rm'];

	const isSshUrl = repoUrl.startsWith('git@') || repoUrl.startsWith('ssh://');
	if (isSshUrl) {
		if (os.platform() === 'darwin') {
			runArgs.push(
				'--mount', 'type=bind,src=/run/host-services/ssh-auth.sock,target=/run/host-services/ssh-auth.sock',
				'-e', 'SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock',
			);
		} else {
			const sshAuthSock = env['SSH_AUTH_SOCK'];
			if (sshAuthSock) {
				runArgs.push(
					'-v', `${sshAuthSock}:/ssh-agent`,
					'-e', 'SSH_AUTH_SOCK=/ssh-agent',
				);
			}
		}
		const knownHostsPath = path.join(os.homedir(), '.ssh', 'known_hosts');
		if (fs.existsSync(knownHostsPath)) {
			runArgs.push('-v', `${knownHostsPath}:/root/.ssh/known_hosts:ro`);
		}
	}

	runArgs.push('-v', `${volumeName}:/workspace`);

	let gitCmd: string;
	if (ref) {
		gitCmd = `git init /workspace && cd /workspace && git remote add origin '${repoUrl}' && git fetch --depth 1 origin '${ref}' && git checkout FETCH_HEAD`;
	} else {
		gitCmd = `git clone --depth 1 '${repoUrl}' /workspace`;
	}
	runArgs.push('--entrypoint', '/bin/sh', 'alpine/git', '-c', gitCmd);

	await dockerCLI(params, ...runArgs);

	// Match standard devcontainer behaviour: workspace owned by UID 1000
	await dockerCLI(params, 'run', '--rm',
		'-v', `${volumeName}:/workspace`,
		'alpine', 'chown', '-R', '1000:1000', '/workspace',
	);
}

// ── Extract files from volume to host ─────────────────────────────────────────

export async function extractFromVolume(
	params: PartialExecParameters,
	volumeName: string,
	destDir: string,
): Promise<void> {
	params.output.write(`Extracting files from volume '${volumeName}' → '${destDir}'...`);
	const createResult = await dockerCLI(params, 'create', '-v', `${volumeName}:/workspace`, 'alpine', 'true');
	const containerId = createResult.stdout.toString().trim();
	try {
		await dockerCLI(params, 'cp', `${containerId}:/workspace/.`, destDir);
	} finally {
		await dockerCLI(params, 'rm', containerId);
	}
}

// ── High-level workspace setup ────────────────────────────────────────────────

export interface WorkspaceVolumeOptions {
	repository?: string;
	repositoryRef?: string;
	genVolPrefix?: string;
	volName?: string;
	fromVol?: string;
	withVol?: string;
	dockerPath: string;
	logFormat: string;
}

export interface WorkspaceVolumeResult {
	volumeName: string;
	tempDir: string;
	repoBasename: string;
}

export async function setupWorkspaceVolume(options: WorkspaceVolumeOptions): Promise<WorkspaceVolumeResult> {
	const { repository, repositoryRef, genVolPrefix, volName, fromVol, withVol, dockerPath, logFormat } = options;

	const cliHost = await getCLIHost(process.cwd(), loadNativeModule, logFormat === 'text');
	const output = makeLog(createPlainLog(
		(text: string) => process.stderr.write(text),
		() => LogLevel.Info,
	));
	const repoParams: PartialExecParameters = {
		exec: cliHost.exec,
		cmd: dockerPath,
		env: cliHost.env,
		output,
	};

	let volumeName: string;
	let repoBasename: string;

	if (withVol) {
		// ── Use existing volume as-is ──
		volumeName = await resolveVolumeRef(repoParams, withVol);
		repoBasename = await getVolumeLabel(repoParams, volumeName, LABEL_REPO_BASENAME) || basenameFromVolume(volumeName);
	} else if (fromVol) {
		// ── Clone from existing volume (labels are copied by cloneVolume) ──
		const sourceVol = await resolveVolumeRef(repoParams, fromVol);
		volumeName = volName
			? volName
			: genVolPrefix
				? await generateVolumeName(repoParams, genVolPrefix)
				: `${sourceVol}-clone`;
		await cloneVolume(repoParams, sourceVol, volumeName);
		repoBasename = await getVolumeLabel(repoParams, volumeName, LABEL_REPO_BASENAME) || basenameFromVolume(volumeName);
	} else if (repository) {
		// ── Clone from remote repository ──
		repoBasename = getRepoBasename(repository);
		volumeName = volName
			? volName
			: genVolPrefix
				? await generateVolumeName(repoParams, genVolPrefix)
				: getAutoVolumeName(repository);
		const volLabels = { [LABEL_REPO_BASENAME]: repoBasename };
		if (!(await volumeHasContent(repoParams, volumeName))) {
			await createVolume(repoParams, volumeName, volLabels);
		}
		await cloneRepoIntoVolume(repoParams, volumeName, repository, repositoryRef);
	} else {
		throw new Error('One of --repository, --from-vol, or --with-vol is required for workspace volume mode.');
	}

	const tmpDir = path.join(os.tmpdir(), `devcontainer-repo-${crypto.randomUUID()}`);
	fs.mkdirSync(tmpDir, { recursive: true });
	await extractFromVolume(repoParams, volumeName, tmpDir);

	return { volumeName, tempDir: tmpDir, repoBasename };
}

function basenameFromVolume(volumeName: string): string {
	const parsed = parseManagedName(volumeName);
	return parsed ? parsed.prefix : volumeName;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
//
//  cleanup ref format:  "prefix@-N"  →  keep the most recent N, remove the rest
//  e.g.  "foo@-1"  → keep 1 latest, remove all older

export interface CleanupOptions {
	volRef?: string;
	ctrRef?: string;
	dockerPath: string;
	logFormat: string;
	dryRun?: boolean;
}

export interface CleanupResult {
	removedVolumes: string[];
	removedContainers: string[];
	errors: string[];
}

export async function cleanupOld(options: CleanupOptions): Promise<CleanupResult> {
	const { volRef, ctrRef, dockerPath, logFormat, dryRun } = options;

	const cliHost = await getCLIHost(process.cwd(), loadNativeModule, logFormat === 'text');
	const output = makeLog(createPlainLog(
		(text: string) => process.stderr.write(text),
		() => LogLevel.Info,
	));
	const params: PartialExecParameters = {
		exec: cliHost.exec,
		cmd: dockerPath,
		env: cliHost.env,
		output,
	};

	const removedVolumes: string[] = [];
	const removedContainers: string[] = [];
	const errors: string[] = [];

	if (ctrRef) {
		const { toRemove } = await resolveCleanupTargets(params, ctrRef, 'ctr');
		for (const name of toRemove) {
			if (dryRun) {
				output.write(`[dry-run] Would remove container '${name}'`);
			} else {
				try {
					await removeContainerForce(params, name);
					removedContainers.push(name);
					output.write(`Removed container '${name}'`);
				} catch (err: any) {
					errors.push(`Failed to remove container '${name}': ${err.message || err}`);
				}
			}
		}
	}

	if (volRef) {
		const { toRemove } = await resolveCleanupTargets(params, volRef, 'vol');
		for (const name of toRemove) {
			if (dryRun) {
				output.write(`[dry-run] Would remove volume '${name}'`);
			} else {
				try {
					await removeVolume(params, name);
					removedVolumes.push(name);
					output.write(`Removed volume '${name}'`);
				} catch (err: any) {
					errors.push(`Failed to remove volume '${name}': ${err.message || err}`);
				}
			}
		}
	}

	return { removedVolumes, removedContainers, errors };
}

async function resolveCleanupTargets(params: PartialExecParameters, ref: string, type: 'vol' | 'ctr'): Promise<{ toRemove: string[]; toKeep: string[] }> {
	const atIdx = ref.indexOf('@');
	if (atIdx === -1) {
		throw new Error(`Cleanup ref must use prefix@-N format (got '${ref}').`);
	}
	const prefix = ref.slice(0, atIdx);
	const selector = ref.slice(atIdx + 1);

	const allNames = type === 'vol' ? await listVolumes(params) : await listContainers(params);
	const matching = filterByPrefixAndType(allNames, prefix, type);

	if (!/^-\d+$/.test(selector)) {
		throw new Error(`Cleanup selector must be -N (got '${selector}').`);
	}
	const keep = Math.abs(parseInt(selector, 10));
	if (keep >= matching.length) {
		return { toRemove: [], toKeep: matching };
	}
	const cutoff = matching.length - keep;
	return {
		toRemove: matching.slice(0, cutoff),
		toKeep: matching.slice(cutoff),
	};
}
