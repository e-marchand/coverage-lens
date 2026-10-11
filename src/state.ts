// The loaded coverage database: where it comes from, and mapping its paths to the checkout.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CoverageDatabase } from './coverage';
import { Unit } from './units';

export const SECTION = 'coverageLens';
export const DEFAULT_IGNORE = '(ThirdParty|/Applications/Xcode|/usr/include|SDKs)';

export function setting<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration(SECTION).get<T>(key, fallback);
}

export function ignorePattern(): RegExp | undefined {
    const pattern = setting<string>('ignorePattern', DEFAULT_IGNORE);
    try {
        return pattern ? new RegExp(pattern) : undefined;
    } catch {
        return new RegExp(DEFAULT_IGNORE);
    }
}

function expand(file: string): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    return file.replace(/^~(?=$|[\\/])/, os.homedir())
        .replace(/\$\{userHome\}/g, os.homedir())
        .replace(/\$\{workspaceFolder\}/g, folder);
}

function megabytes(bytes: number): string {
    return (bytes / 1048576).toFixed(0);
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class CoverageState implements vscode.Disposable {
    db: CoverageDatabase | undefined;
    /** Where the database came from: a file, or the URL it was downloaded from. */
    origin: string | undefined;
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    /** Checkout folders found by matching open files to database paths. */
    private readonly sourceRoots = new Set<string>();
    private loading: Promise<void> | undefined;

    constructor(private readonly storage: vscode.Uri, readonly log: vscode.LogOutputChannel) {}

    dispose(): void {
        this.db?.close();
        this.changed.dispose();
    }

    load(refresh = false): Promise<void> {
        const run = async () => {
            await this.loading;
            await this.open(refresh);
        };
        this.loading = run();
        return this.loading;
    }

    private async open(refresh: boolean): Promise<void> {
        this.db?.close();
        this.db = undefined;
        this.origin = setting<string>('database', '').trim() || undefined;
        if (this.origin) {
            try {
                const file = /^https?:\/\//i.test(this.origin)
                    ? await this.download(this.origin, refresh) : expand(this.origin);
                if (!fs.existsSync(file)) {
                    throw new Error(`coverage database not found: ${file}`);
                }
                let module: typeof import('./coverage');
                try {
                    module = await import('./coverage');
                } catch (error) {
                    throw new Error(`this VS Code cannot read SQLite (node:sqlite needs VS Code 1.101 or later): ${message(error)}`);
                }
                this.db = new module.CoverageDatabase(file);
                this.log.info(`Loaded ${file}: ${this.db.tests.length} tests, ${this.db.fileCount} files`);
            } catch (error) {
                this.log.error(message(error));
                void vscode.window.showErrorMessage(`Coverage Lens: ${message(error)}`, 'Select Database…')
                    .then(choice => choice && vscode.commands.executeCommand('coverageLens.selectDatabase'));
            }
        }
        await vscode.commands.executeCommand('setContext', 'coverageLens.hasDatabase', !!this.db);
        this.changed.fire();
    }

    /** Download the database to global storage, again only when the server has a newer one. */
    private async download(url: string, force: boolean): Promise<string> {
        await fs.promises.mkdir(this.storage.fsPath, { recursive: true });
        const key = createHash('sha256').update(url).digest('hex').slice(0, 16);
        const file = path.join(this.storage.fsPath, `coverage-${key}.sqlite`);
        const metaFile = `${file}.json`;
        const have = fs.existsSync(file);
        let meta: { etag?: string; lastModified?: string } = {};
        try {
            meta = JSON.parse(await fs.promises.readFile(metaFile, 'utf8'));
        } catch {
            // No previous download.
        }
        const headers: Record<string, string> = {};
        if (have && !force) {
            if (meta.etag) {
                headers['If-None-Match'] = meta.etag;
            }
            if (meta.lastModified) {
                headers['If-Modified-Since'] = meta.lastModified;
            }
        }
        const controller = new AbortController();
        let response: Response;
        try {
            response = await fetch(url, { headers, signal: controller.signal });
        } catch (error) {
            if (have) {
                this.log.warn(`${url} unreachable (${message(error)}), using the copy downloaded before`);
                return file;
            }
            throw new Error(`cannot download ${url}: ${message(error)}`);
        }
        if (response.status === 304 && have) {
            this.log.info(`${url} unchanged since the last download`);
            return file;
        }
        if (!response.ok || !response.body) {
            if (have) {
                this.log.warn(`${url}: HTTP ${response.status}, using the copy downloaded before`);
                return file;
            }
            throw new Error(`cannot download ${url}: HTTP ${response.status}`);
        }
        const total = Number(response.headers.get('content-length')) || 0;
        const body = response.body;
        const partial = `${file}.part`;
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Coverage Lens: downloading the coverage database',
            cancellable: true,
        }, async (progress, token) => {
            token.onCancellationRequested(() => controller.abort());
            let received = 0, reported = 0;
            const stream = Readable.fromWeb(body as import('node:stream/web').ReadableStream);
            stream.on('data', (chunk: Buffer) => {
                received += chunk.length;
                const percent = total ? (received * 100) / total : 0;
                progress.report({
                    increment: percent - reported,
                    message: total ? `${megabytes(received)} / ${megabytes(total)} MB` : `${megabytes(received)} MB`,
                });
                reported = percent;
            });
            await pipeline(stream, fs.createWriteStream(partial));
        });
        await fs.promises.rename(partial, file);
        await fs.promises.writeFile(metaFile, JSON.stringify({
            etag: response.headers.get('etag') ?? undefined,
            lastModified: response.headers.get('last-modified') ?? undefined,
        }));
        this.log.info(`Downloaded ${url} to ${file}`);
        return file;
    }

    /** The functions of a file of the checkout, by start line. */
    unitsForFile(fsPath: string): Unit[] {
        if (!this.db) {
            return [];
        }
        const file = fsPath.replace(/\\/g, '/');
        const paths = this.db.resolve(file);
        for (const dbPath of paths) {
            if (file.endsWith('/' + dbPath)) {
                this.sourceRoots.add(file.slice(0, file.length - dbPath.length));
            }
        }
        return this.db.unitsFor(file);
    }

    /** The checkout file of a database path. */
    async locate(dbPath: string, root?: string): Promise<vscode.Uri | undefined> {
        const roots = [root, ...this.sourceRoots, ...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)];
        for (const folder of roots) {
            if (folder && fs.existsSync(path.join(folder, dbPath))) {
                return vscode.Uri.file(path.join(folder, dbPath));
            }
        }
        const [found] = await vscode.workspace.findFiles(`**/${dbPath}`, '**/node_modules/**', 1);
        return found;
    }

    async openUnit(unit: Unit, root?: string): Promise<void> {
        const uri = await this.locate(unit.path, root);
        if (!uri) {
            void vscode.window.showWarningMessage(`Coverage Lens: ${unit.path} is not in this workspace`);
            return;
        }
        const position = new vscode.Position(Math.max(unit.start - 1, 0), 0);
        await vscode.window.showTextDocument(uri, { selection: new vscode.Range(position, position) });
    }
}
