import { execFile } from 'node:child_process';

export function git(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, maxBuffer: 512 * 1024 * 1024 }, (error, stdout, stderr) => {
            error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout);
        });
    });
}

export async function repoRoot(directory: string): Promise<string> {
    return (await git(directory, ['rev-parse', '--show-toplevel'])).trim();
}

/** `git diff` with the given arguments, plain and with paths unquoted. */
export function diff(root: string, args: string[]): Promise<string> {
    return git(root, ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', ...args]);
}

export interface Commit {
    sha: string;
    short: string;
    subject: string;
    author: string;
    date: string;
}

export async function recentCommits(root: string, count = 50): Promise<Commit[]> {
    const out = await git(root, ['log', `-n${count}`, '--format=%H%x09%h%x09%an%x09%ar%x09%s']);
    return out.split('\n').filter(Boolean).map(line => {
        const [sha, short, author, date, ...subject] = line.split('\t');
        return { sha, short, author, date, subject: subject.join('\t') };
    });
}

/** The diff a commit made against its first parent. */
export async function commitDiff(root: string, sha: string): Promise<string> {
    try {
        return await diff(root, [`${sha}^`, sha]);
    } catch {
        // A root commit: compare with the empty tree.
        return diff(root, ['4b825dc642cb6eb9a060e54bf8d69288fbee4904', sha]);
    }
}
